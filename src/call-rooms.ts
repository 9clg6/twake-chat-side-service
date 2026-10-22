import type postgres from 'postgres'
import { UpstreamError } from './upstream.ts'

/**
 * How long a call waits for the replica making the Meet room of the same Matrix room,
 * which waits for Meet (two calls of 5 s at most). A call still waiting for a connection
 * of the pool is bounded by the deadline of the route instead.
 */
const LOCK_TIMEOUT_SECONDS = 12

/**
 * The Meet room of each Matrix room. Meet names its rooms itself, so the row is the
 * only link from a Matrix room to its call, shared by every replica.
 */
export class CallRooms {
  readonly #sql: postgres.Sql
  readonly #lockTimeout: string

  constructor(
    sql: postgres.Sql,
    { lockTimeoutSeconds = LOCK_TIMEOUT_SECONDS } = {}
  ) {
    this.#sql = sql
    this.#lockTimeout = `${String(lockTimeoutSeconds)}s`
  }

  /** Creates the table; replicas starting together wait for each other instead of racing on it. */
  async migrate(): Promise<void> {
    await this.#sql.begin(async sql => {
      await sql`select pg_advisory_xact_lock(hashtextextended('call_rooms', 0))`
      await sql`create table if not exists call_rooms (
        matrix_room_id text primary key,
        meet_room_id text not null
      )`
    })
  }

  /**
   * The Meet room of the Matrix room, made by `create` when it has none. The lock per
   * Matrix room holds the other replicas until the row is written: never two Meet rooms.
   */
  async ensure(
    matrixRoomId: string,
    create: () => Promise<string>
  ): Promise<string> {
    let created: Promise<string> | undefined
    try {
      const known = await this.#find(this.#sql, matrixRoomId)
      if (known) return known

      // Read committed: the second read must see the row the previous holder of the lock wrote
      return await this.#sql.begin(
        'isolation level read committed',
        async sql => {
          await sql`select set_config('lock_timeout', ${this.#lockTimeout}, true)`
          await sql`select pg_advisory_xact_lock(hashtextextended(${matrixRoomId}, 0))`
          const madeMeanwhile = await this.#find(sql, matrixRoomId)
          if (madeMeanwhile) return madeMeanwhile
          created = create()
          const meetRoomId = await created
          await sql`insert into call_rooms (matrix_room_id, meet_room_id)
            values (${matrixRoomId}, ${meetRoomId})`
          return meetRoomId
        }
      )
    } catch (err) {
      // A failure of `create` goes through as it is
      const failedToCreate = await created?.then(
        () => false,
        (error: unknown) => error === err
      )
      throw failedToCreate ? err : databaseFailure(err)
    }
  }

  /** Drops the link only while it still holds this Meet room: another replica may have replaced it. */
  async forget(matrixRoomId: string, meetRoomId: string): Promise<void> {
    try {
      await this.#sql`delete from call_rooms
        where matrix_room_id = ${matrixRoomId} and meet_room_id = ${meetRoomId}`
    } catch (err) {
      throw databaseFailure(err)
    }
  }

  async #find(
    sql: postgres.Sql | postgres.TransactionSql,
    matrixRoomId: string
  ): Promise<string | null> {
    const [row] = await sql<{ meet_room_id: string }[]>`
      select meet_room_id from call_rooms where matrix_room_id = ${matrixRoomId}`
    return row?.meet_room_id ?? null
  }
}

/** Postgres answered an error, or its connection failed: both carry a code. */
function databaseFailure(err: unknown): unknown {
  return err instanceof Error && 'code' in err && typeof err.code === 'string'
    ? new UpstreamError('database', err.message)
    : err
}
