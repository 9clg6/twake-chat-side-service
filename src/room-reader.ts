import { z } from 'zod'
import { call, callForStream, readJson, UpstreamError } from './upstream.ts'

const eventSchema = z.object({
  type: z.string(),
  sender: z.string(),
  event_id: z.string(),
  origin_server_ts: z.number(),
  state_key: z.string().optional(),
  content: z.record(z.string(), z.unknown())
})
const listedRoomSchema = z.object({
  room_id: z.string(),
  canonical_alias: z.string().optional(),
  world_readable: z.boolean(),
  join_rule: z.string().optional(),
  room_type: z.string().optional()
})

export type RoomEvent = z.infer<typeof eventSchema>
export type ListedRoom = z.infer<typeof listedRoomSchema>

const PUBLIC_ROOMS_LIMIT = 500
/** At most this many pages of the directory: 50 000 rooms, the limit of one sitemap. */
const PUBLIC_ROOMS_PAGES = 100
/** The posts, their edits and their reactions. */
const MESSAGES_FILTER = JSON.stringify({
  types: ['m.room.message', 'm.reaction']
})
const MESSAGES_LIMIT = 100
/** At most this many pages of `/messages` per read: reactions alone may fill a few. */
const MESSAGES_PAGES = 5

const room = (roomId: string) =>
  `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}`

/**
 * The homeserver read as the account of the service (`sender_localpart`), never on
 * behalf of a user: its registration has no `rooms` namespace, so Synapse applies
 * `history_visibility` to it as to anyone outside the room.
 */
export class RoomReader {
  #url: string
  #asToken: string

  constructor(url: string, asToken: string) {
    this.#url = url.replace(/\/+$/, '')
    this.#asToken = asToken
  }

  async resolveAlias(alias: string): Promise<string | null> {
    const path = `/_matrix/client/v3/directory/room/${encodeURIComponent(alias)}`
    const body = await this.#read(path)
    return typeof body?.room_id === 'string' ? body.room_id : null
  }

  /** Whether the room is in the room directory of the homeserver. */
  async isPublished(roomId: string): Promise<boolean> {
    const path = `/_matrix/client/v3/directory/list/room/${encodeURIComponent(roomId)}`
    return (await this.#read(path))?.visibility === 'public'
  }

  /** The state of the room, null when the service may not read it. */
  async state(roomId: string): Promise<RoomEvent[] | null> {
    const path = `${room(roomId)}/state`
    const response = await this.#get(path)
    if (response.status === 403 || response.status === 404) return null
    if (!response.ok) {
      throw new UpstreamError(
        'homeserver',
        `${path} answered ${String(response.status)}`
      )
    }
    return parse(path, z.array(eventSchema), await response.json())
  }

  /** Newest first, page after page until `enough` holds or the room starts. */
  async messages(
    roomId: string,
    enough: (events: RoomEvent[]) => boolean
  ): Promise<RoomEvent[]> {
    const events: RoomEvent[] = []
    let from: string | undefined
    for (let page = 0; page < MESSAGES_PAGES; page++) {
      const query = new URLSearchParams({
        dir: 'b',
        limit: String(MESSAGES_LIMIT),
        filter: MESSAGES_FILTER,
        ...(from && { from })
      })
      const path = `${room(roomId)}/messages?${query.toString()}`
      const body = await this.#read(path)
      if (!body) break
      // Redacted events lose their content keys, not the content
      events.push(...parse(path, z.array(eventSchema), body.chunk))
      if (typeof body.end !== 'string' || enough(events)) break
      from = body.end
    }
    return events
  }

  /** The rooms of the directory; `complete` is false when it outgrew `PUBLIC_ROOMS_PAGES`. */
  async publicRooms(): Promise<{ rooms: ListedRoom[]; complete: boolean }> {
    const rooms: ListedRoom[] = []
    let since: string | undefined
    for (let page = 0; page < PUBLIC_ROOMS_PAGES; page++) {
      const query = new URLSearchParams({
        limit: String(PUBLIC_ROOMS_LIMIT),
        ...(since && { since })
      })
      const path = `/_matrix/client/v3/publicRooms?${query.toString()}`
      const body = await readJson('homeserver', path, await this.#get(path))
      rooms.push(...parse(path, z.array(listedRoomSchema), body.chunk))
      if (typeof body.next_batch !== 'string') return { rooms, complete: true }
      since = body.next_batch
    }
    return { rooms, complete: false }
  }

  download(server: string, mediaId: string): Promise<Response> {
    return callForStream(
      'homeserver',
      `${this.#url}/_matrix/client/v1/media/download/${encodeURIComponent(server)}/${encodeURIComponent(mediaId)}`,
      { headers: { authorization: `Bearer ${this.#asToken}` } }
    )
  }

  /** The JSON body, null on a 403 or a 404. */
  async #read(path: string): Promise<Record<string, unknown> | null> {
    const response = await this.#get(path)
    if (response.status === 403 || response.status === 404) return null
    return readJson('homeserver', path, response)
  }

  #get(path: string): Promise<Response> {
    return call('homeserver', `${this.#url}${path}`, {
      headers: { authorization: `Bearer ${this.#asToken}` }
    })
  }
}

function parse<T>(path: string, schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    throw new UpstreamError('homeserver', `${path} answered an unknown shape`)
  }
  return parsed.data
}
