import { call, readJson, UpstreamError } from './upstream.ts'

const USERINFO_PATH = '/_matrix/federation/v1/openid/userinfo'

/**
 * The OpenID tokens a Matrix client gets from its homeserver (`/user/{userId}/openid/request_token`),
 * checked by that homeserver: the token says who stands behind a call request.
 */
export class OpenId {
  #url: string

  constructor(homeserverUrl: string) {
    this.#url = homeserverUrl.replace(/\/+$/, '')
  }

  /** The Matrix id the token stands for, or null when the homeserver rejects it. */
  async userOf(accessToken: string): Promise<string | null> {
    const response = await call(
      'homeserver',
      `${this.#url}${USERINFO_PATH}?${new URLSearchParams({ access_token: accessToken }).toString()}`
    )
    if (response.status === 401) {
      return null
    }
    const body = await readJson('homeserver', USERINFO_PATH, response)
    if (typeof body.sub !== 'string' || !/^@[^:]+:.+$/.test(body.sub)) {
      throw new UpstreamError(
        'homeserver',
        `${USERINFO_PATH} answered no user id`
      )
    }

    return body.sub
  }
}
