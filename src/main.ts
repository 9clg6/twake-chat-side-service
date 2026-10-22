import { setTimeout as delay } from 'node:timers/promises'
import { pino } from 'pino'
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

let accepting = false
const server = createServer({
  logger,
  isReady: () => Promise.resolve(accepting)
})
await server.listen({ host: config.HTTP_HOST, port: config.HTTP_PORT })

accepting = true
lifecycle.started(async () => {
  accepting = false
  await delay(DRAIN_MS)
  await server.close()
})
