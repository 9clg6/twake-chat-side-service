import { z } from 'zod'

const configSchema = z.object({
  HTTP_HOST: z.string().min(1).default('0.0.0.0'),
  HTTP_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info')
})

export type Config = z.infer<typeof configSchema>

/** The configuration from the environment; an empty variable counts as unset. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const set = Object.fromEntries(
    Object.entries(env).filter(([, value]) => value !== '')
  )
  const parsed = configSchema.safeParse(set)
  if (!parsed.success) {
    const problems = parsed.error.issues.map(
      issue => `${issue.path.join('.')}: ${issue.message}`
    )
    throw new Error(`Invalid configuration: ${problems.join('; ')}`)
  }
  return parsed.data
}
