import { call, readJson } from './upstream.ts'

const MODERATOR_POWER_LEVEL = 50
/** From this room version, the creators hold the power of `m.room.create`, not a level in `m.room.power_levels`. */
const CREATORS_FROM_ROOM_VERSION = 12

/** The homeserver, read with the `as_token` of the registration: no admin token. */
export class Homeserver {
  #url: string
  #asToken: string

  constructor(url: string, asToken: string) {
    this.#url = url.replace(/\/+$/, '')
    this.#asToken = asToken
  }

  /** MSC4502: the scope `is_joined` of the registration answers for any room the homeserver is in. */
  async isJoined(roomId: string, userId: string): Promise<boolean> {
    const path = `/_matrix/client/unstable/io.element.msc4502/rooms/${encodeURIComponent(roomId)}/is_joined`
    const response = await this.#get(path, { mxid: userId })
    // A room id Synapse cannot read names no room anyone is in
    if (response.status === 400) {
      return false
    }
    const body = await readJson('homeserver', path, response)

    return body.joined === true
  }

  /**
   * Whether the user may moderate the room: a creator of a room of version 12 or later,
   * or a power level of a moderator. Read as the user, whom the namespace of the
   * registration lets the service act for: the service is in no room.
   */
  async isModerator(roomId: string, userId: string): Promise<boolean> {
    const [create, powerLevels] = await Promise.all([
      this.#state(roomId, 'm.room.create', userId),
      this.#state(roomId, 'm.room.power_levels', userId)
    ])
    const createContent = (create?.content ?? {}) as Record<string, unknown>
    if (Number(createContent.room_version) >= CREATORS_FROM_ROOM_VERSION) {
      const additional = Array.isArray(createContent.additional_creators)
        ? createContent.additional_creators
        : []
      if (create?.sender === userId || additional.includes(userId)) {
        return true
      }
    }
    // Without power levels, the creator alone holds the level of 100 (the spec)
    if (!powerLevels) {
      return create?.sender === userId
    }
    const content = (powerLevels.content ?? {}) as Record<string, unknown>
    const users = (content.users ?? {}) as Record<string, unknown>
    // Rooms before version 10 may hold the level as a string
    const level = Number(users[userId] ?? content.users_default ?? 0)

    return level >= MODERATOR_POWER_LEVEL
  }

  async displayName(userId: string): Promise<string | null> {
    const path = `/_matrix/client/v3/profile/${encodeURIComponent(userId)}/displayname`
    const response = await this.#get(path, { user_id: userId })
    if (response.status === 404) {
      return null
    }
    const body = await readJson('homeserver', path, response)

    return typeof body.displayname === 'string' && body.displayname
      ? body.displayname
      : null
  }

  /** The state event as the user sees it (`format=event`, for the sender), null when the room has none. */
  async #state(
    roomId: string,
    type: string,
    userId: string
  ): Promise<Record<string, unknown> | null> {
    const path = `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/${type}/`
    const response = await this.#get(path, { user_id: userId, format: 'event' })
    if (response.status === 404) {
      return null
    }

    return readJson('homeserver', path, response)
  }

  #get(path: string, query: Record<string, string>): Promise<Response> {
    return call(
      'homeserver',
      `${this.#url}${path}?${new URLSearchParams(query).toString()}`,
      {
        headers: { authorization: `Bearer ${this.#asToken}` }
      }
    )
  }
}
