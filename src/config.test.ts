import { describe, expect, it } from 'vitest'
import { loadConfig } from './config.ts'

describe('loadConfig', () => {
  it('reads the environment, with its defaults', () => {
    expect(loadConfig({ HTTP_PORT: '9000' })).toEqual({
      HTTP_HOST: '0.0.0.0',
      HTTP_PORT: 9000,
      LOG_LEVEL: 'info'
    })
  })

  it('takes an empty variable as unset', () => {
    expect(loadConfig({ HTTP_PORT: '' }).HTTP_PORT).toBe(8080)
  })

  it('names every invalid variable', () => {
    expect(() => loadConfig({ HTTP_PORT: 'http', LOG_LEVEL: 'loud' })).toThrow(
      /HTTP_PORT.*LOG_LEVEL/
    )
  })
})
