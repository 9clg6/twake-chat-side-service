// What a room shows as a public page. Pure: no network, no clock.
import type { ListedRoom, RoomEvent } from './room-reader.ts'

/** The state event (state key "") of a room whose owner turned its public page on (D178). */
export const PUBLIC_PAGE_EVENT = 'app.twake.chat.public_page'

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/
/** A room id; from room version 12 it names no server (MSC4291). */
const ROOM_ID = /^![A-Za-z0-9._=\-/+]+(?::[A-Za-z0-9.:-]+)?$/
const MXC = /^mxc:\/\/([A-Za-z0-9.:-]+)\/([A-Za-z0-9_-]+)$/

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
