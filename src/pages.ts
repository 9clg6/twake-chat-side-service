// What a room shows as a public page. Pure: no network, no clock.
import type { ListedRoom, RoomEvent } from './room-reader.ts'

/** The state event (state key "") of a room whose owner turned its public page on (D178). */
export const PUBLIC_PAGE_EVENT = 'app.twake.chat.public_page'
/** How the page looks, set in « Edit » of Twake Chat (D350). */
const PAGE_STYLE_EVENT = 'app.twake.chat.page_style'
/** The posts shown on a page, newest first. */
const POST_LIMIT = 30

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/
/** A room id; from room version 12 it names no server (MSC4291). */
const ROOM_ID = /^![A-Za-z0-9._=\-/+]+(?::[A-Za-z0-9.:-]+)?$/
/** A server name of DNS labels and a port: never `..`, which would climb the media path. */
const MXC =
  /^mxc:\/\/([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*(?::\d+)?)\/([A-Za-z0-9_-]+)$/

export interface Post {
  id: string
  author: string
  at: number
  text: string
  /** The `formatted_body` (org.matrix.custom.html), unsanitized. */
  formatted: string | null
  image: { url: string; alt: string } | null
  /** Distinct members per reaction key. */
  reactions: Record<string, number>
}

/** What a page shows. `ref` is the slug or the room id of its URL. */
export interface Page {
  ref: string
  roomId: string
  name: string
  topic: string
  avatarUrl: string | null
  coverUrl: string | null
  /** The colour its owner chose (D350), `#rrggbb`; null: the palette's. */
  accentColor: string | null
  followerCount: number
  posts: Post[]
}

export type Ref = { alias: string } | { roomId: string }

/**
 * The one form of a URL reference, a slug or a room id; null for anything else. A
 * link encoded twice (`%253A`, by a chat that encodes it again) is read once more,
 * for the page to redirect it to this form.
 */
export function canonicalRef(given: string): string | null {
  let ref = given
  if (ref.includes('%')) {
    try {
      ref = decodeURIComponent(ref)
    } catch {
      return null
    }
  }
  return SLUG.test(ref) || ROOM_ID.test(ref) ? ref : null
}

/** What a canonical ref names: the local alias `#slug:server`, or the room id. */
export function parseRef(ref: string, serverName: string): Ref | null {
  if (SLUG.test(ref)) return { alias: `#${ref}:${serverName}` }
  return ROOM_ID.test(ref) ? { roomId: ref } : null
}

export function parseMxc(url: unknown): { server: string; id: string } | null {
  const match = typeof url === 'string' ? MXC.exec(url) : null
  return match?.[1] && match[2] ? { server: match[1], id: match[2] } : null
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const text = (value: unknown): string =>
  typeof value === 'string' ? value : ''

const contentOf = (state: RoomEvent[], type: string) =>
  state.find(event => event.type === type && event.state_key === '')?.content ??
  {}

/**
 * THE gate (D178, D388): anyone may read the history and join, the room is not
 * encrypted, not a space, and its owner turned the page on. Every page, media and
 * sitemap entry goes through it.
 */
export function isPublic(state: RoomEvent[]): boolean {
  const of = (type: string) => contentOf(state, type)
  return (
    of('m.room.history_visibility').history_visibility === 'world_readable' &&
    of('m.room.join_rules').join_rule === 'public' &&
    !state.some(event => event.type === 'm.room.encryption') &&
    of('m.room.create').type !== 'm.space' &&
    of(PUBLIC_PAGE_EVENT).enabled === true
  )
}

/** What the directory tells of the gate; the opt-in and the encryption are in the state. */
export const isCandidate = (room: ListedRoom): boolean =>
  room.world_readable &&
  room.join_rule === 'public' &&
  room.room_type !== 'm.space'

/** The ref of a listed room: its local alias slug, else its room id. */
export function sitemapRef(
  room: ListedRoom,
  serverName: string
): string | null {
  const alias = room.canonical_alias
  if (alias?.endsWith(`:${serverName}`)) {
    const slug = alias.slice(1, alias.indexOf(':'))
    if (SLUG.test(slug)) return slug
  }
  return ROOM_ID.test(room.room_id) ? room.room_id : null
}

const relationOf = (event: RoomEvent) => {
  const relation = event.content['m.relates_to']
  return isRecord(relation) ? relation : null
}

/** The replacements (m.replace) of each post, newest first, by post id. */
function editsOf(messages: RoomEvent[]): Map<string, RoomEvent[]> {
  const edits = new Map<string, RoomEvent[]>()
  for (const event of messages) {
    const relation = relationOf(event)
    if (
      relation?.rel_type === 'm.replace' &&
      isRecord(event.content['m.new_content'])
    ) {
      const target = text(relation.event_id)
      edits.set(target, [...(edits.get(target) ?? []), event])
    }
  }
  return edits
}

/** Distinct senders per key of the m.annotation reactions, by reacted event id. */
function reactionsOf(
  messages: RoomEvent[]
): Map<string, Map<string, Set<string>>> {
  const byEvent = new Map<string, Map<string, Set<string>>>()
  for (const event of messages) {
    const relation = relationOf(event)
    const key = text(relation?.key)
    if (
      event.type !== 'm.reaction' ||
      relation?.rel_type !== 'm.annotation' ||
      !key
    ) {
      continue
    }
    const eventId = text(relation.event_id)
    const keys = byEvent.get(eventId) ?? new Map<string, Set<string>>()
    keys.set(key, (keys.get(key) ?? new Set()).add(event.sender))
    byEvent.set(eventId, keys)
  }
  return byEvent
}

/** A redacted post has no body; edits and thread replies are no posts. */
function isPost(event: RoomEvent): boolean {
  const type = relationOf(event)?.rel_type
  return (
    event.type === 'm.room.message' &&
    typeof event.content.body === 'string' &&
    type !== 'm.replace' &&
    type !== 'm.thread'
  )
}

/** Whether the messages read so far, newest first, hold every post a page shows. */
export const hasAllPosts = (messages: RoomEvent[]): boolean =>
  messages.filter(isPost).length >= POST_LIMIT

function postsOf(messages: RoomEvent[], names: Map<string, string>): Post[] {
  const edits = editsOf(messages)
  const reactions = reactionsOf(messages)
  return messages
    .filter(isPost)
    .slice(0, POST_LIMIT)
    .map(event => {
      // Only its sender may edit a post (spec, event replacements)
      const edit = edits
        .get(event.event_id)
        ?.find(replacement => replacement.sender === event.sender)
      const content = edit
        ? (edit.content['m.new_content'] as Record<string, unknown>)
        : event.content
      const isImage =
        content.msgtype === 'm.image' && parseMxc(content.url) !== null
      const formatted =
        !isImage && content.format === 'org.matrix.custom.html'
          ? text(content.formatted_body)
          : ''
      return {
        id: event.event_id,
        author: names.get(event.sender) || event.sender,
        at: event.origin_server_ts,
        text: isImage ? '' : text(content.body),
        formatted: formatted || null,
        image: isImage
          ? { url: text(content.url), alt: text(content.body) }
          : null,
        reactions: Object.fromEntries(
          [...(reactions.get(event.event_id) ?? [])].map(([key, senders]) => [
            key,
            senders.size
          ])
        )
      }
    })
}

/** What the page of the room shows; null when the room fails the gate. */
export function readPage(
  ref: string,
  roomId: string,
  state: RoomEvent[],
  messages: RoomEvent[]
): Page | null {
  if (!isPublic(state)) return null
  const of = (type: string) => contentOf(state, type)
  const members = state.filter(event => event.type === 'm.room.member')
  const names = new Map(
    members.map(event => [
      event.state_key ?? '',
      text(event.content.displayname)
    ])
  )
  const style = of(PAGE_STYLE_EVENT)
  const color = text(style.accent_color)
  const avatar = text(of('m.room.avatar').url)
  return {
    ref,
    roomId,
    name: text(of('m.room.name').name) || ref,
    topic: text(of('m.room.topic').topic),
    avatarUrl: parseMxc(avatar) ? avatar : null,
    coverUrl: parseMxc(style.cover_url) ? text(style.cover_url) : null,
    accentColor: /^#[0-9a-f]{6}$/i.test(color) ? color : null,
    followerCount: members.filter(event => event.content.membership === 'join')
      .length,
    posts: postsOf(messages, names)
  }
}

/** Every media the page shows: the only ones its media route serves. */
export function mediaOf(page: Page): Set<string> {
  return new Set(
    [
      page.avatarUrl,
      page.coverUrl,
      ...page.posts.map(post => post.image?.url)
    ].filter(url => url !== null && url !== undefined)
  )
}
