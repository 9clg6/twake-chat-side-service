import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { OpenId } from './openid.ts'
import { startFake } from './testing.ts'
import { UpstreamError } from './upstream.ts'

const answers: Record<string, { status: number; body: unknown }> = {
  good: { status: 200, body: { sub: '@alice:example.org' } },
  rejected: { status: 401, body: { errcode: 'M_UNKNOWN_TOKEN' } },
  broken: { status: 500, body: { errcode: 'M_UNKNOWN' } },
  odd: { status: 200, body: { sub: 'alice' } }
}
const seen: string[] = []
let fake: Awaited<ReturnType<typeof startFake>>
let openId: OpenId

beforeAll(async () => {
  fake = await startFake(app => {
    app.get('/*', (request, reply) => {
      const url = new URL(request.url, 'http://fake')
      seen.push(url.pathname)
      const answer = answers[url.searchParams.get('access_token') ?? ''] ?? {
        status: 404,
        body: {}
      }
      return reply.code(answer.status).send(answer.body)
    })
  })
  openId = new OpenId(fake.url)
})

afterAll(() => fake.close())

describe('OpenId', () => {
  it('asks the homeserver who the token stands for', async () => {
    expect(await openId.userOf('good')).toBe('@alice:example.org')
    expect(seen).toEqual(['/_matrix/federation/v1/openid/userinfo'])
  })

  it('tells a rejected token from a failure of the homeserver', async () => {
    expect(await openId.userOf('rejected')).toBeNull()
    await expect(openId.userOf('broken')).rejects.toBeInstanceOf(UpstreamError)
    await expect(openId.userOf('odd')).rejects.toBeInstanceOf(UpstreamError)
  })
})
