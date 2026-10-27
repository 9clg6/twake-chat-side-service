import { createHash } from 'node:crypto'
import { pipeline, Readable, Transform } from 'node:stream'
import type { ReadableStream } from 'node:stream/web'
import type { FastifyReply } from 'fastify'
import type { HttpServer } from './http.ts'
import {
  canonicalRef,
  hasAllPosts,
  isCandidate,
  isPublic,
  mediaOf,
  type Page,
  parseRef,
  readPage,
  sitemapRef
} from './pages.ts'
import {
  accentStyleOf,
  langOf,
  NOT_FOUND,
  pagePath,
  renderPage,
  renderRobots,
  renderSitemap,
  STYLESHEET,
  STYLESHEET_PATH
} from './render.ts'
import type { RoomReader } from './room-reader.ts'
import { UpstreamError } from './upstream.ts'

/** How long a page is kept before the homeserver is read again. */
const PAGE_MS = 60_000
const PAGE_MAX = 1000
/** How long the sitemap is kept: the `max-age` of its answer. */
const SITEMAP_MS = 300_000
/** State reads of the sitemap in flight at once. */
const SITEMAP_READS = 8
/** How long a failed sitemap is answered as is, rather than read again from a homeserver down. */
const SITEMAP_FAILURE_MS = 10_000

/**
 * No script runs on a page; images and the stylesheet come from this service only,
 * and the one inline style is the colour of the room, allowed by its hash.
 */
function htmlHeaders(inlineStyle: string | null = null) {
  const styleSrc = inlineStyle
    ? `'self' 'sha256-${createHash('sha256').update(inlineStyle).digest('base64')}'`
    : "'self'"
  return {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': `default-src 'none'; img-src 'self'; style-src ${styleSrc}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin'
  }
}

const MEDIA_MAX_BYTES = 50 * 1024 * 1024

/** A stream that fails once more than `max` bytes went through it. */
function capped(max: number): Transform {
  let seen = 0
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      seen += chunk.length
      done(seen > max ? new Error('media over its size limit') : null, chunk)
    }
  })
}

/** What a page may serve as a media: never a document that runs script. */
const isServedMedia = (type: string): boolean =>
  /^(image\/(png|jpeg|gif|webp|avif)|video\/[\w.+-]+|audio\/[\w.+-]+)$/.test(
    type
  )

export interface PublicPagesDeps {
  reader: RoomReader
  serverName: string
  /** The public address of this service, for the links of the pages. */
  publicUrl: string
  /** The address of Twake Chat, where « React in Twake Chat » opens the room. */
  chatUrl: string
  now?: () => number
  /** The pages each replica keeps, the least read dropped first. */
  pageCacheSize?: number
  /** The largest media served, 50 MiB by default. */
  mediaMaxBytes?: number
}

const notFound = (reply: FastifyReply) =>
  reply.code(404).headers(htmlHeaders()).send(NOT_FOUND)

/** A homeserver that fails answers 502; anything else is a bug, thrown on. */
function upstreamFailed(reply: FastifyReply, err: unknown): FastifyReply {
  if (!(err instanceof UpstreamError)) throw err
  reply.log.warn({ reason: err.message }, 'public page failed')
  return reply
    .code(502)
    .type('text/plain; charset=utf-8')
    .send('The homeserver did not answer.\n')
}

/** The pages of the rooms open to all (D388, D398): read only, without state. */
export function registerPublicPages(
  app: HttpServer,
  deps: PublicPagesDeps
): void {
  const {
    reader,
    serverName,
    now = Date.now,
    pageCacheSize = PAGE_MAX,
    mediaMaxBytes = MEDIA_MAX_BYTES
  } = deps
  const publicUrl = deps.publicUrl.replace(/\/+$/, '')
  const chatUrl = deps.chatUrl.replace(/\/+$/, '')
  // In the order of their last read, as a Map keeps its keys. The refs that name no
  // page are kept apart: a burst of them never drops a page.
  const pages = new Map<string, { at: number; page: Page }>()
  const missing = new Map<string, { at: number }>()
  /** The reads in flight, which the requests of their ref meanwhile share. */
  const reading = new Map<string, Promise<Page | null>>()
  let sitemap: { at: number; xml: string } | null = null
  let rendering: Promise<string> | null = null
  let failed: { at: number; error: Error } | null = null

  /**
   * The page of a ref, read at most once a minute per replica, and once at a time:
   * the requests meanwhile share the read. Null: none to show.
   */
  function pageOf(ref: string): Promise<Page | null> {
    const kept = recall(pages, ref)
    if (kept) return Promise.resolve(kept.page)
    if (recall(missing, ref)) return Promise.resolve(null)
    let read = reading.get(ref)
    if (!read) {
      // A failed read is not kept
      read = readFresh(ref)
        .then(page => {
          if (page) keep(pages, ref, { at: now(), page })
          else keep(missing, ref, { at: now() })
          return page
        })
        .finally(() => {
          reading.delete(ref)
        })
      reading.set(ref, read)
    }
    return read
  }

  /** The entry of a ref read less than `PAGE_MS` ago, moved last. */
  function recall<T extends { at: number }>(
    cache: Map<string, T>,
    ref: string
  ): T | null {
    const entry = cache.get(ref)
    if (!entry) return null
    cache.delete(ref)
    if (now() - entry.at >= PAGE_MS) return null
    cache.set(ref, entry)
    return entry
  }

  /** Keeps an entry, dropping the least read one when the cache is full. */
  function keep<T>(cache: Map<string, T>, ref: string, entry: T): void {
    const oldest = cache.keys().next()
    if (cache.size >= pageCacheSize && !oldest.done) cache.delete(oldest.value)
    cache.set(ref, entry)
  }

  /** The gate runs before any message or media of the room is read. */
  async function readFresh(ref: string): Promise<Page | null> {
    const parsed = parseRef(ref, serverName)
    if (!parsed) return null
    const roomId =
      'roomId' in parsed
        ? parsed.roomId
        : await reader.resolveAlias(parsed.alias)
    if (!roomId || !(await reader.isPublished(roomId))) return null
    const state = await reader.state(roomId)
    if (!state || !isPublic(state)) return null
    const messages = await reader.messages(roomId, hasAllPosts)
    return readPage(ref, roomId, state, messages)
  }

  /** The refs of the directory rooms that pass the gate, one state read per candidate. */
  async function sitemapRefs(): Promise<string[]> {
    const { rooms, complete } = await reader.publicRooms()
    if (!complete) {
      app.log.warn(
        { rooms: rooms.length },
        'sitemap cut: the room directory outgrew what it reads'
      )
    }
    const candidates = rooms.filter(isCandidate)
    const refs: string[] = []
    for (let i = 0; i < candidates.length; i += SITEMAP_READS) {
      const batch = candidates.slice(i, i + SITEMAP_READS)
      // A state read that fails drops its room, not the whole sitemap
      const states = await Promise.allSettled(
        batch.map(room => reader.state(room.room_id))
      )
      batch.forEach((room, j) => {
        const read = states[j]
        const ref = sitemapRef(room, serverName)
        if (ref && read?.status === 'fulfilled' && read.value) {
          if (isPublic(read.value)) refs.push(ref)
        }
      })
    }
    return refs
  }

  /** Rendered at most once per `SITEMAP_MS` and once at a time; a failure is kept `SITEMAP_FAILURE_MS`. */
  function sitemapXml(): Promise<string> {
    if (sitemap && now() - sitemap.at < SITEMAP_MS) {
      return Promise.resolve(sitemap.xml)
    }
    if (failed && now() - failed.at < SITEMAP_FAILURE_MS) {
      return Promise.reject(failed.error)
    }
    rendering ??= sitemapRefs()
      .then(refs => {
        const xml = renderSitemap(refs, publicUrl)
        sitemap = { at: now(), xml }
        return xml
      })
      .catch((err: unknown) => {
        if (err instanceof Error) failed = { at: now(), error: err }
        throw err
      })
      .finally(() => {
        rendering = null
      })
    return rendering
  }

  app.get('/robots.txt', (_request, reply) =>
    reply.type('text/plain; charset=utf-8').send(renderRobots(publicUrl))
  )

  app.get(STYLESHEET_PATH, (_request, reply) =>
    reply
      .type('text/css; charset=utf-8')
      .headers({
        // Its URL changes with its content
        'cache-control': 'public, max-age=31536000, immutable',
        'x-content-type-options': 'nosniff'
      })
      .send(STYLESHEET)
  )

  app.get('/sitemap.xml', async (_request, reply) => {
    try {
      const xml = await sitemapXml()
      return await reply
        .header('cache-control', `public, max-age=${String(SITEMAP_MS / 1000)}`)
        .type('application/xml')
        .send(xml)
    } catch (err) {
      return upstreamFailed(reply, err)
    }
  })

  app.get<{ Params: { ref: string } }>('/b/:ref', async (request, reply) => {
    const ref = canonicalRef(request.params.ref)
    if (!ref) return notFound(reply)
    // A link encoded twice is sent to the page. The raw path is not compared: a
    // proxy may hand it on decoded (`:` for `%3A`), which is the same address
    if (ref !== request.params.ref) {
      return reply.redirect(`${publicUrl}${pagePath(ref)}`, 301)
    }
    try {
      const page = await pageOf(ref)
      if (!page) return await notFound(reply)
      const lang = langOf(request.headers['accept-language'])
      return await reply
        .headers(htmlHeaders(accentStyleOf(page)))
        .header('cache-control', `public, max-age=${String(PAGE_MS / 1000)}`)
        .header('vary', 'accept-language')
        .send(renderPage(page, { publicUrl, chatUrl, lang }))
    } catch (err) {
      return upstreamFailed(reply, err)
    }
  })

  app.get<{ Params: { ref: string; server: string; id: string } }>(
    '/b/:ref/media/:server/:id',
    async (request, reply) => {
      const { ref, server, id } = request.params
      // Only the pages link to their media, in the one form of their ref
      if (canonicalRef(ref) !== ref) return notFound(reply)
      try {
        const page = await pageOf(ref)
        if (!page || !mediaOf(page).has(`mxc://${server}/${id}`)) {
          return await notFound(reply)
        }
        const media = await reader.download(server, id)
        if (!media.ok || !media.body) {
          await media.body?.cancel()
          return await notFound(reply)
        }
        const type = media.headers.get('content-type') ?? ''
        const length = Number(media.headers.get('content-length'))
        if (!isServedMedia(type) || length > mediaMaxBytes) {
          await media.body.cancel()
          return await notFound(reply)
        }
        return await reply
          .type(type)
          .headers({
            // As the page: turning it off unpublishes its media within a minute
            'cache-control': `public, max-age=${String(PAGE_MS / 1000)}`,
            'x-content-type-options': 'nosniff',
            'content-security-policy': "default-src 'none'; sandbox"
          })
          .send(
            // A body without its length is cut past the limit as well
            pipeline(
              Readable.fromWeb(media.body as ReadableStream<Uint8Array>),
              capped(mediaMaxBytes),
              () => undefined
            )
          )
      } catch (err) {
        return upstreamFailed(reply, err)
      }
    }
  )
}
