import { describe, expect, it } from 'vitest'
import { loadConfig } from './config.ts'

const REQUIRED = {
  AS_TOKEN: 'as',
  MATRIX_HOMESERVER_URL: 'http://synapse:8008',
  MATRIX_SERVER_NAME: 'example.org',
  DATABASE_URL: 'postgres://db/visio',
  MEET_URL: 'https://meet.example.org',
  MEET_CLIENT_ID: 'chat',
  MEET_CLIENT_SECRET: 'meet-secret',
  MEET_SERVICE_ACCOUNT_EMAIL: 'calls@example.org',
  LDAP_URL: 'ldap://ldap',
  LDAP_BASE: 'ou=users,dc=example,dc=org'
}

describe('loadConfig', () => {
  it('reads the environment, with its defaults', () => {
    expect(loadConfig(REQUIRED)).toEqual({
      ...REQUIRED,
      LDAP_UID_ATTRIBUTE: 'uid',
      HTTP_HOST: '0.0.0.0',
      HTTP_PORT: 8080,
      LOG_LEVEL: 'info'
    })
  })

  it('takes an empty variable as unset', () => {
    expect(loadConfig({ ...REQUIRED, HTTP_PORT: '' }).HTTP_PORT).toBe(8080)
  })

  it('names every missing or invalid variable', () => {
    expect(() =>
      loadConfig({ ...REQUIRED, AS_TOKEN: '', DATABASE_URL: 'mysql://db' })
    ).toThrow(/AS_TOKEN.*DATABASE_URL|DATABASE_URL.*AS_TOKEN/)
  })

  it('wants the password of a bind DN', () => {
    expect(() =>
      loadConfig({ ...REQUIRED, LDAP_BIND_DN: 'cn=admin,dc=example,dc=org' })
    ).toThrow('LDAP_BIND_PASSWORD: required with LDAP_BIND_DN')
  })
})
