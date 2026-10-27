import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { pino } from 'pino'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createServer } from './http.ts'
import { PUBLIC_PAGE_EVENT } from './pages.ts'
import { type PublicPagesDeps, registerPublicPages } from './public-pages.ts'
import { RoomReader } from './room-reader.ts'
import { startFake } from './testing.ts'
import { UPSTREAM_TIMEOUT_MS } from './upstream.ts'

const ROOM = '!room:example.org'
const ROOM_PATH = `/_matrix/client/v3/rooms/${ROOM}`

interface Answer {
  status: number
  body: unknown
  /** Of a media, `image/png` by default. */
  type?: string
  headers?: Record<string, string>
}
let answers: Record<string, (query: URLSearchParams) => Answer> = {}
const queries: Record<string, string>[] = []
let fake: Awaited<ReturnType<typeof startFake>>
let reads = 0

const ok = (body: unknown) => () => ({ status: 200, body })
const stateEvent = (type: string, content: Record<string, unknown>) => ({
  type,
  content,
  state_key: '',
  sender: '@alice:example.org',
  event_id: `$${type}`,
  origin_server_ts: 1
})

function publicRoom(joinRule = 'public') {
  answers['/_matrix/client/v3/directory/room/#news:example.org'] = ok({
    room_id: ROOM
  })
  answers[`/_matrix/client/v3/directory/list/room/${ROOM}`] = ok({
    visibility: 'public'
  })
  answers[`${ROOM_PATH}/state`] = () => {
    reads += 1
    return {
      status: 200,
      body: [
        stateEvent('m.room.create', { room_version: '11' }),
        stateEvent('m.room.history_visibility', {
          history_visibility: 'world_readable'
        }),
        stateEvent('m.room.join_rules', { join_rule: joinRule }),
        stateEvent('m.room.name', { name: 'News' }),
        stateEvent('m.room.avatar', { url: 'mxc://example.org/avatar' }),
        stateEvent(PUBLIC_PAGE_EVENT, { enabled: true })
      ]
    }
  }
  answers[`${ROOM_PATH}/messages`] = ok({
    chunk: [
      {
        type: 'm.room.message',
        content: { msgtype: 'm.text', body: 'Hello world' },
        sender: '@alice:example.org',
        event_id: '$post',
        origin_server_ts: 2
      }
    ]
  })
}

beforeAll(async () => {
  fake = await startFake(app => {
    app.get('/*', (request, reply) => {
      const url = new URL(request.url, 'http://fake')
      queries.push(Object.fromEntries(url.searchParams))
      const answer = answers[decodeURIComponent(url.pathname)]?.(
        url.searchParams
      ) ?? {
        status: 404,
        body: { errcode: 'M_NOT_FOUND' }
      }
      if (typeof answer.body === 'string' || answer.body instanceof Readable) {
        return reply
          .code(answer.status)
          .type(answer.type ?? 'image/png')
          .headers(answer.headers ?? {})
          .send(answer.body)
      }
      return reply.code(answer.status).send(answer.body)
    })
  })
})

afterAll(() => fake.close())

let now = 0
const warnings: string[] = []
async function pages(
  limits: Pick<PublicPagesDeps, 'pageCacheSize' | 'mediaMaxBytes'> = {}
) {
  const app = createServer({
    logger: pino({ level: 'warn' }, { write: line => warnings.push(line) }),
    isReady: () => Promise.resolve(true)
  })
  registerPublicPages(app, {
    reader: new RoomReader(fake.url, 'as-secret'),
    serverName: 'example.org',
    publicUrl: 'https://pages.example.org/',
    chatUrl: 'https://chat.example.org',
    now: () => now,
    ...limits
  })
  await app.ready()
  return app
}

beforeEach(() => {
  answers = {}
  queries.length = 0
  reads = 0
  now = 0
  warnings.length = 0
})

describe('GET /b/:ref', () => {
  it('serves the page of a published room open to all, read as the service', async () => {
    publicRoom()
    const app = await pages()

    const response = await app.inject({ url: '/b/news' })

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-security-policy']).toContain(
      "default-src 'none'"
    )
    expect(response.body).toContain('<h1>News</h1>')
    expect(response.body).toContain('Hello world')
    expect(response.body).toContain(
      'https://chat.example.org/rooms/!room%3Aexample.org'
    )
    // Never on behalf of a user: the as_token alone
    expect(queries.some(query => 'user_id' in query)).toBe(false)
  })

  it('allows its stylesheet and no inline style but the colour of its room', async () => {
    publicRoom()
    const app = await pages()
    const plain = await app.inject({ url: '/b/news' })

    expect(plain.headers['content-security-policy']).toContain(
      "style-src 'self';"
    )

    const state = answers[`${ROOM_PATH}/state`]
    answers[`${ROOM_PATH}/state`] = query => {
      const answer = state?.(query) ?? { status: 404, body: [] }
      return {
        ...answer,
        body: [
          ...(answer.body as unknown[]),
          stateEvent('app.twake.chat.page_style', { accent_color: '#ff8800' })
        ]
      }
    }
    now = 60_000
    const styled = await app.inject({ url: '/b/news' })
    const hash = createHash('sha256')
      .update(':root{--accent:#ff8800}')
      .digest('base64')

    expect(styled.body).toContain('<style>:root{--accent:#ff8800}</style>')
    expect(styled.headers['content-security-policy']).toContain(
      `style-src 'self' 'sha256-${hash}';`
    )
    expect(styled.headers['content-security-policy']).not.toContain(
      'unsafe-inline'
    )
  })

  it('reads the homeserver again after a minute only', async () => {
    publicRoom()
    const app = await pages()

    await app.inject({ url: '/b/news' })
    await app.inject({ url: '/b/news' })
    now = 60_000
    await app.inject({ url: '/b/news' })

    expect(reads).toBe(2)
  })

  it('reads the homeserver once for the requests that come together', async () => {
    publicRoom()
    const app = await pages()

    const responses = await Promise.all(
      Array.from({ length: 50 }, () => app.inject({ url: '/b/news' }))
    )

    expect(responses.every(response => response.statusCode === 200)).toBe(true)
    expect(reads).toBe(1)
  })

  it('drops the least read page when full, not the ones read often', async () => {
    publicRoom()
    for (const slug of ['a', 'b', 'c']) {
      answers[`/_matrix/client/v3/directory/room/#${slug}:example.org`] = ok({
        room_id: ROOM
      })
    }
    const app = await pages({ pageCacheSize: 2 })

    for (const slug of ['a', 'b', 'a', 'c', 'a']) {
      await app.inject({ url: `/b/${slug}` })
    }

    expect(reads).toBe(3)
  })

  it('drops no page for a burst of refs that name none', async () => {
    publicRoom()
    const app = await pages({ pageCacheSize: 2 })

    await app.inject({ url: '/b/news' })
    for (let i = 0; i < 10; i++) {
      await app.inject({ url: `/b/unknown-${String(i)}` })
    }
    await app.inject({ url: '/b/news' })

    expect(reads).toBe(1)
  })

  it('sends a link encoded twice to the page', async () => {
    publicRoom()
    const app = await pages()

    const spellings: [string, string][] = [
      ['/b/%256eews', 'https://pages.example.org/b/news'],
      [
        '/b/%2521room%253Aexample.org',
        'https://pages.example.org/b/!room%3Aexample.org'
      ]
    ]
    for (const [url, location] of spellings) {
      const response = await app.inject({ url })

      expect([response.statusCode, response.headers.location]).toEqual([
        301,
        location
      ])
    }
    expect(reads).toBe(0)
  })

  it('serves a page under its address however a proxy encodes it', async () => {
    publicRoom()
    const app = await pages()

    // As nginx hands it on with an URI in proxy_pass: decoded
    for (const url of [
      '/b/!room:example.org',
      '/b/!room%3Aexample.org',
      '/b/%6eews'
    ]) {
      expect((await app.inject({ url })).statusCode).toBe(200)
    }
  })

  it('pages back through the messages until it has the posts of the page', async () => {
    publicRoom()
    const reaction = {
      type: 'm.reaction',
      content: {
        'm.relates_to': {
          rel_type: 'm.annotation',
          event_id: '$post',
          key: '👍'
        }
      },
      sender: '@bob:example.org',
      origin_server_ts: 3
    }
    answers[`${ROOM_PATH}/messages`] = query =>
      query.get('from') === 'older'
        ? {
            status: 200,
            body: {
              chunk: [
                {
                  type: 'm.room.message',
                  content: { msgtype: 'm.text', body: 'Hello world' },
                  sender: '@alice:example.org',
                  event_id: '$post',
                  origin_server_ts: 2
                }
              ]
            }
          }
        : {
            status: 200,
            body: {
              chunk: Array.from({ length: 100 }, (_, i) => ({
                ...reaction,
                event_id: `$reaction${String(i)}`
              })),
              end: 'older'
            }
          }
    const app = await pages()

    const response = await app.inject({ url: '/b/news' })

    expect(response.body).toContain('Hello world')
    expect(response.body).toContain('👍 1')
  })

  it('shows no page of a room on invitation', async () => {
    publicRoom('invite')
    const app = await pages()

    expect((await app.inject({ url: '/b/news' })).statusCode).toBe(404)
  })

  it('shows no page of a room out of the directory, without reading it', async () => {
    publicRoom()
    answers[`/_matrix/client/v3/directory/list/room/${ROOM}`] = ok({
      visibility: 'private'
    })
    const app = await pages()

    expect((await app.inject({ url: '/b/news' })).statusCode).toBe(404)
    expect(reads).toBe(0)
  })

  it('shows no page of a room the service may not read', async () => {
    publicRoom()
    answers[`${ROOM_PATH}/state`] = () => ({
      status: 403,
      body: { errcode: 'M_FORBIDDEN' }
    })
    const app = await pages()

    expect((await app.inject({ url: '/b/news' })).statusCode).toBe(404)
  })

  it('answers 502 when the homeserver fails', async () => {
    publicRoom()
    answers[`${ROOM_PATH}/state`] = () => ({ status: 500, body: {} })
    const app = await pages()

    expect((await app.inject({ url: '/b/news' })).statusCode).toBe(502)
  })
})

describe('GET /b/:ref/media/:server/:id', () => {
  it('serves a media the page shows, and no other', async () => {
    publicRoom()
    answers['/_matrix/client/v1/media/download/example.org/avatar'] = ok('PNG')
    answers['/_matrix/client/v1/media/download/example.org/other'] = ok('PNG')
    const app = await pages()

    const avatar = await app.inject({
      url: '/b/news/media/example.org/avatar'
    })
    const other = await app.inject({ url: '/b/news/media/example.org/other' })

    expect(avatar.statusCode).toBe(200)
    expect(avatar.headers['content-type']).toBe('image/png')
    expect(avatar.headers['cache-control']).toBe('public, max-age=60')
    expect(avatar.body).toBe('PNG')
    expect(other.statusCode).toBe(404)
    expect(queries.some(query => 'user_id' in query)).toBe(false)
  })

  it('serves no media that is a document, such as svg or html', async () => {
    publicRoom()
    const app = await pages()

    for (const type of ['image/svg+xml', 'text/html']) {
      answers['/_matrix/client/v1/media/download/example.org/avatar'] = () => ({
        status: 200,
        body: '<svg onload="alert(1)"/>',
        type
      })

      const response = await app.inject({
        url: '/b/news/media/example.org/avatar'
      })

      expect(response.statusCode).toBe(404)
      expect(response.body).not.toContain('alert')
    }
  })

  it('serves no media larger than its limit, with its length or without', async () => {
    publicRoom()
    const app = await pages({ mediaMaxBytes: 4 })
    const avatar = '/_matrix/client/v1/media/download/example.org/avatar'

    answers[avatar] = () => ({
      status: 200,
      body: 'PNGPNG',
      headers: { 'content-length': '6' }
    })
    const declared = await app.inject({
      url: '/b/news/media/example.org/avatar'
    })
    expect(declared.statusCode).toBe(404)

    answers[avatar] = () => ({
      status: 200,
      body: Readable.from(['PNG', 'PNG'])
    })
    const streamed = await app
      .inject({ url: '/b/news/media/example.org/avatar' })
      .catch(() => null)
    expect(streamed?.body).not.toBe('PNGPNG')
  })

  it('serves the media of a page under the one address of its page only', async () => {
    publicRoom()
    answers['/_matrix/client/v1/media/download/example.org/avatar'] = ok('PNG')
    const app = await pages()

    const response = await app.inject({
      url: '/b/%256eews/media/example.org/avatar'
    })

    expect(response.statusCode).toBe(404)
  })

  it('streams a media for as long as it takes once its headers come', async () => {
    publicRoom()
    answers['/_matrix/client/v1/media/download/example.org/avatar'] = () => ({
      status: 200,
      body: Readable.from(
        (async function* () {
          yield 'P'
          await new Promise(resolve =>
            setTimeout(resolve, UPSTREAM_TIMEOUT_MS + 500)
          )
          yield 'NG'
        })()
      )
    })
    const app = await pages()

    const avatar = await app.inject({ url: '/b/news/media/example.org/avatar' })

    expect([avatar.statusCode, avatar.body]).toEqual([200, 'PNG'])
  }, 10_000)
})

describe('GET /sitemap.xml', () => {
  it('lists the directory rooms that pass the gate', async () => {
    publicRoom()
    answers['/_matrix/client/v3/publicRooms'] = ok({
      chunk: [
        {
          room_id: ROOM,
          canonical_alias: '#news:example.org',
          world_readable: true,
          join_rule: 'public'
        },
        {
          room_id: '!closed:example.org',
          world_readable: true,
          join_rule: 'invite'
        }
      ]
    })
    const app = await pages()

    const response = await app.inject({ url: '/sitemap.xml' })

    expect(response.statusCode).toBe(200)
    expect(response.body).toContain(
      '<loc>https://pages.example.org/b/news</loc>'
    )
    expect(response.body).not.toContain('closed')
    expect(queries.some(query => 'user_id' in query)).toBe(false)
  })

  it('leaves out the rooms whose state fails the gate', async () => {
    publicRoom()
    const listed = (roomId: string) => ({
      room_id: roomId,
      world_readable: true,
      join_rule: 'public'
    })
    answers['/_matrix/client/v3/publicRooms'] = ok({
      chunk: [ROOM, '!off:example.org', '!secret:example.org'].map(listed)
    })
    const open = [
      stateEvent('m.room.history_visibility', {
        history_visibility: 'world_readable'
      }),
      stateEvent('m.room.join_rules', { join_rule: 'public' })
    ]
    answers['/_matrix/client/v3/rooms/!off:example.org/state'] = ok([
      ...open,
      stateEvent(PUBLIC_PAGE_EVENT, { enabled: false })
    ])
    answers['/_matrix/client/v3/rooms/!secret:example.org/state'] = ok([
      ...open,
      stateEvent(PUBLIC_PAGE_EVENT, { enabled: true }),
      stateEvent('m.room.encryption', { algorithm: 'm.megolm.v1.aes-sha2' })
    ])
    const app = await pages()

    const response = await app.inject({ url: '/sitemap.xml' })

    expect(response.body).toContain('/b/!room%3Aexample.org')
    expect(response.body).not.toContain('off')
    expect(response.body).not.toContain('secret')
  })

  it('says so when the room directory outgrows what it reads', async () => {
    publicRoom()
    answers['/_matrix/client/v3/publicRooms'] = ok({
      chunk: [],
      next_batch: 'more'
    })
    const app = await pages()

    expect((await app.inject({ url: '/sitemap.xml' })).statusCode).toBe(200)
    expect(warnings.some(line => line.includes('sitemap cut'))).toBe(true)
  })

  it('keeps a failure a few seconds, rather than reading a homeserver down on each request', async () => {
    let listings = 0
    answers['/_matrix/client/v3/publicRooms'] = () => {
      listings += 1
      return { status: 500, body: {} }
    }
    const app = await pages()

    expect((await app.inject({ url: '/sitemap.xml' })).statusCode).toBe(502)
    expect((await app.inject({ url: '/sitemap.xml' })).statusCode).toBe(502)
    expect(listings).toBe(1)
    now = 10_000
    await app.inject({ url: '/sitemap.xml' })
    expect(listings).toBe(2)
  })
})

describe('GET /b/assets/page.css', () => {
  it('serves the stylesheet of the pages, kept as long as its URL', async () => {
    const app = await pages()

    const response = await app.inject({ url: '/b/assets/page.css?v=any' })

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toBe('text/css; charset=utf-8')
    expect(response.headers['cache-control']).toBe(
      'public, max-age=31536000, immutable'
    )
    expect(response.body).toContain('--twake-palette-background-default')
  })
})
