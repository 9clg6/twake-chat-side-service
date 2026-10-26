import { readFileSync } from 'node:fs'
import { initSentry } from '@linagora/twake-node-telemetry/sentry'

const { version } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
) as { version: string }

// Loaded with --import, before main.ts, so Sentry can instrument the modules
// main.ts loads. Without SENTRY_DSN, nothing is sent.
initSentry({ service: 'twake-chat-side-service', version })
