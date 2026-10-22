import type { EventEmitter } from 'node:events'
import type { Logger } from 'pino'

// Before `started`, nothing serves traffic or holds a delivery, and an
// unfinished migration rolls back, so a signal ends the process right away.
export function handleSignals(deps: {
  log: Logger
  deadlineMs: number
  signals?: EventEmitter
  exit?: (code: number) => void
}) {
  const { log, deadlineMs } = deps
  const signals = deps.signals ?? process
  const exit = deps.exit ?? ((code: number) => process.exit(code))
  let stop: (() => Promise<void>) | undefined
  let stopping = false

  const onSignal = (signal: string) => {
    if (stopping) return
    stopping = true
    if (!stop) {
      log.info({ signal }, 'stopped during startup')
      exit(0)
      return
    }
    log.info({ signal }, 'shutting down')
    setTimeout(() => {
      log.error({ deadlineMs }, 'shutdown took too long')
      exit(1)
    }, deadlineMs).unref()
    stop().then(
      () => {
        exit(0)
      },
      (error: unknown) => {
        log.error({ err: error }, 'shutdown failed')
        exit(1)
      }
    )
  }
  signals.once('SIGTERM', onSignal)
  signals.once('SIGINT', onSignal)

  return {
    started(fn: () => Promise<void>) {
      stop = fn
    }
  }
}
