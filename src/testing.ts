import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import postgres from 'postgres'

const SERVER_URL =
  process.env.TEST_DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5432/postgres'

export interface TestDb {
  url: string
  drop(): Promise<void>
}

// One database per test file, so files run in parallel.
export async function createTestDb(): Promise<TestDb> {
  const name = `test_${randomUUID().replaceAll('-', '')}`
  const server = postgres(SERVER_URL, { max: 1, onnotice: () => undefined })
  await server.unsafe(`create database ${name}`)
  const url = new URL(SERVER_URL)
  url.pathname = `/${name}`
  return {
    url: url.toString(),
    async drop() {
      await server.unsafe(`drop database ${name} with (force)`)
      await server.end()
    }
  }
}

/** A fake upstream on a free port of the loopback: IPv4, as `localhost` may resolve to IPv6. */
export async function startFake(
  routes: (app: FastifyInstance) => void
): Promise<{ url: string; close: () => Promise<void> }> {
  const app = Fastify()
  routes(app)
  const url = await app.listen({ host: '127.0.0.1', port: 0 })
  return { url, close: () => app.close() }
}
