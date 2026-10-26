import { pino } from 'pino'
import { describe, expect, it } from 'vitest'
import { createServer } from './http.ts'

function server(ready = true) {
  return createServer({
    logger: pino({ level: 'silent' }),
    isReady: () => Promise.resolve(ready)
  })
}

describe('createServer', () => {
  it('is alive', async () => {
    const response = await server().inject({ url: '/health/live' })

    expect([response.statusCode, response.json()]).toEqual([
      200,
      { status: 'ok' }
    ])
  })

  it('is ready while the database answers', async () => {
    expect((await server().inject({ url: '/health/ready' })).statusCode).toBe(
      200
    )
    const response = await server(false).inject({ url: '/health/ready' })

    expect([response.statusCode, response.json()]).toEqual([
      503,
      { status: 'unavailable' }
    ])
  })

  it("takes the request id from the caller's X-Request-Id", async () => {
    const app = server()
    app.get('/id', request => ({ id: request.id }))

    const response = await app.inject({
      url: '/id',
      headers: { 'x-request-id': 'from-proxy-1' }
    })

    expect(response.json()).toEqual({ id: 'from-proxy-1' })
  })

  it('answers anything else with a Matrix 404', async () => {
    const response = await server().inject({ url: '/elsewhere' })

    expect([response.statusCode, response.json()]).toEqual([
      404,
      { errcode: 'M_UNRECOGNIZED', error: 'Unrecognized request' }
    ])
  })

  it('answers a body it cannot parse with M_NOT_JSON, a failure with a bare 500', async () => {
    const app = server()
    app.post('/echo', () => 'ok')
    app.get('/boom', () => {
      throw new Error('connect ECONNREFUSED 10.0.0.7:5432')
    })

    const notJson = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{'
    })
    const boom = await app.inject({ url: '/boom' })

    expect([
      notJson.statusCode,
      notJson.json<{ errcode: string }>().errcode
    ]).toEqual([400, 'M_NOT_JSON'])
    expect([boom.statusCode, boom.json()]).toEqual([
      500,
      { errcode: 'M_UNKNOWN', error: 'Internal error' }
    ])
  })

  it('answers the other refusals of Fastify with their own status', async () => {
    const app = server()
    app.post('/echo', () => 'ok')
    const post = (headers: Record<string, string>, payload: string) =>
      app.inject({ method: 'POST', url: '/echo', headers, payload })

    const tooLarge = await post(
      { 'content-type': 'application/json' },
      JSON.stringify({ padding: 'x'.repeat(1_100_000) })
    )
    const unsupported = await post({ 'content-type': 'text/csv' }, 'a,b')

    expect([
      tooLarge.statusCode,
      tooLarge.json<{ errcode: string }>().errcode
    ]).toEqual([413, 'M_TOO_LARGE'])
    expect([
      unsupported.statusCode,
      unsupported.json<{ errcode: string }>().errcode
    ]).toEqual([415, 'M_UNKNOWN'])
  })
})
