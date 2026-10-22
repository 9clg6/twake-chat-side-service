import { EventEmitter } from 'node:events'
import { pino } from 'pino'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { handleSignals } from './lifecycle.ts'

const log = pino({ level: 'silent' })

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

function setUp() {
  const signals = new EventEmitter()
  const exit = vi.fn<(code: number) => void>()
  const lifecycle = handleSignals({ log, signals, exit, deadlineMs: 1000 })
  return { signals, exit, lifecycle }
}

it('exits at once on a signal during startup', () => {
  const { signals, exit } = setUp()

  signals.emit('SIGTERM', 'SIGTERM')

  expect(exit).toHaveBeenCalledWith(0)
})

it('stops once started, then exits', async () => {
  const { signals, exit, lifecycle } = setUp()
  const stop = vi.fn(() => Promise.resolve())
  lifecycle.started(stop)

  signals.emit('SIGTERM', 'SIGTERM')
  signals.emit('SIGINT', 'SIGINT')
  await vi.runAllTimersAsync()

  expect(stop).toHaveBeenCalledOnce()
  expect(exit).toHaveBeenCalledWith(0)
})

it('exits with an error when stopping fails', async () => {
  const { signals, exit, lifecycle } = setUp()
  lifecycle.started(() => Promise.reject(new Error('broker gone')))

  signals.emit('SIGTERM', 'SIGTERM')
  await vi.runAllTimersAsync()

  expect(exit).toHaveBeenCalledWith(1)
})

it('exits with an error when stopping outlives the deadline', async () => {
  const { signals, exit, lifecycle } = setUp()
  lifecycle.started(() => new Promise(() => undefined))

  signals.emit('SIGTERM', 'SIGTERM')
  await vi.advanceTimersByTimeAsync(999)
  expect(exit).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)

  expect(exit).toHaveBeenCalledWith(1)
})
