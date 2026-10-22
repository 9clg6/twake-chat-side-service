import { setTimeout as delay } from 'node:timers/promises'
import { pino } from 'pino'
import postgres from 'postgres'
import { CallRooms } from './call-rooms.ts'
import { loadConfig } from './config.ts'
import { createServer } from './http.ts'
import { handleSignals } from './lifecycle.ts'

// Readiness answers 503 this long before the server closes, so the load
// balancer stops routing here first. Both fit the default 30 s grace period.
const DRAIN_MS = 5000
const SHUTDOWN_DEADLINE_MS = 25_000

const config = loadConfig()
const logger = pino({ level: config.LOG_LEVEL })
const lifecycle = handleSignals({
  log: logger,
  deadlineMs: SHUTDOWN_DEADLINE_MS
})

const connect = (max?: number) =>
  postgres(config.DATABASE_URL, {
    connect_timeout: 5,
    onnotice: () => undefined,
    ...(max && { max })
  })
const sql = connect()
// Its own connection: calls waiting for a Meet room may hold every one of the pool
const probe = connect(1)
await new CallRooms(sql).migrate()

let accepting = false
const server = createServer({
  logger,
  // A database that holds the connection without answering is not ready either
  isReady: () =>
    Promise.race([
      probe`select 1`.then(() => accepting),
      delay(2000).then(() => false)
    ])
})
await server.listen({ host: config.HTTP_HOST, port: config.HTTP_PORT })

accepting = true
lifecycle.started(async () => {
  accepting = false
  await delay(DRAIN_MS)
  await server.close()
  await Promise.all([sql.end({ timeout: 5 }), probe.end({ timeout: 5 })])
})
