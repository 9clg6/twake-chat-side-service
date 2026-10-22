import { setTimeout as delay } from 'node:timers/promises'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { CallRooms } from './call-rooms.ts'
import { createTestDb, type TestDb } from './testing.ts'
import { UpstreamError } from './upstream.ts'

const ROOM = '!room:example.org'

describe('CallRooms', () => {
  let testDb: TestDb
  // Two pools: two replicas of the service
  let firstPool: postgres.Sql
  let secondPool: postgres.Sql
  let first: CallRooms
  let second: CallRooms

  beforeAll(async () => {
    testDb = await createTestDb()
    firstPool = postgres(testDb.url)
    secondPool = postgres(testDb.url)
    first = new CallRooms(firstPool)
    second = new CallRooms(secondPool)
    await Promise.all([first.migrate(), second.migrate()])
  })

  beforeEach(async () => {
    await firstPool`truncate call_rooms`
  })

  afterAll(async () => {
    await Promise.all([firstPool.end(), secondPool.end()])
    await testDb.drop()
  })

  it('makes one Meet room when replicas ask for it together', async () => {
    let made = 0
    const create = async () => {
      made += 1
      await delay(50)
      return `meet-${String(made)}`
    }

    // Settled: a rejected call must not leave the others writing into the next test
    const rooms = await Promise.allSettled([
      first.ensure(ROOM, create),
      second.ensure(ROOM, create),
      first.ensure(ROOM, create),
      second.ensure(ROOM, create)
    ])

    expect(made).toBe(1)
    expect(rooms).toEqual(
      Array.from({ length: 4 }, () => ({
        status: 'fulfilled',
        value: 'meet-1'
      }))
    )
  })

  it('keeps the Meet room of each Matrix room', async () => {
    await first.ensure(ROOM, () => Promise.resolve('meet-a'))

    expect(await second.ensure(ROOM, () => Promise.resolve('other'))).toBe(
      'meet-a'
    )
    expect(
      await second.ensure('!other:example.org', () => Promise.resolve('meet-b'))
    ).toBe('meet-b')
  })

  it('writes no row when the Meet room could not be made, and lets its failure through', async () => {
    // A network error carries a code, as those of the database do
    const meetDown = Object.assign(new Error('socket hang up'), {
      code: 'ECONNRESET'
    })

    await expect(
      first.ensure(ROOM, () => Promise.reject(meetDown))
    ).rejects.toBe(meetDown)
    expect(await second.ensure(ROOM, () => Promise.resolve('meet-2'))).toBe(
      'meet-2'
    )
  })

  it('gives up waiting for the replica that makes the Meet room', async () => {
    const impatient = new CallRooms(secondPool, { lockTimeoutSeconds: 1 })
    const slow = first.ensure(ROOM, async () => {
      await delay(1500)
      return 'meet-1'
    })
    await delay(100)

    await expect(
      impatient.ensure(ROOM, () => Promise.resolve('meet-2'))
    ).rejects.toBeInstanceOf(UpstreamError)
    expect(await slow).toBe('meet-1')
  })

  it('forgets a Meet room only while it is still the linked one', async () => {
    await first.ensure(ROOM, () => Promise.resolve('meet-1'))

    await second.forget(ROOM, 'meet-0')
    expect(await first.ensure(ROOM, () => Promise.resolve('new'))).toBe(
      'meet-1'
    )

    await second.forget(ROOM, 'meet-1')
    expect(await first.ensure(ROOM, () => Promise.resolve('meet-2'))).toBe(
      'meet-2'
    )
  })

  it('turns a database that cannot be reached into an upstream failure', async () => {
    const unreachable = postgres('postgres://nobody@127.0.0.1:1/none', {
      connect_timeout: 1
    })
    try {
      await expect(
        new CallRooms(unreachable).ensure(ROOM, () => Promise.resolve('x'))
      ).rejects.toBeInstanceOf(UpstreamError)
    } finally {
      await unreachable.end()
    }
  })
})
