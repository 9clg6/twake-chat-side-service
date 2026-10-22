import { describe, expect, it } from 'vitest'
import { loadConfig } from './config.ts'

const REQUIRED = { DATABASE_URL: 'postgres://db/visio' }

describe('loadConfig', () => {
  it('reads the environment, with its defaults', () => {
    expect(loadConfig({ ...REQUIRED, HTTP_PORT: '9000' })).toEqual({
      ...REQUIRED,
      HTTP_HOST: '0.0.0.0',
      HTTP_PORT: 9000,
      LOG_LEVEL: 'info'
    })
  })

  it('takes an empty variable as unset', () => {
    expect(loadConfig({ ...REQUIRED, HTTP_PORT: '' }).HTTP_PORT).toBe(8080)
  })

  it('names every missing or invalid variable', () => {
    expect(() =>
      loadConfig({ DATABASE_URL: 'mysql://db', LOG_LEVEL: 'loud' })
    ).toThrow(/DATABASE_URL.*LOG_LEVEL/)
  })
})
