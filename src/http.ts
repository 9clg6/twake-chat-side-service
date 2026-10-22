import Fastify, { LogController, type FastifyRequest } from 'fastify'
import type { Logger } from 'pino'

/** A Matrix error body: what MatrixRTC clients read. */
export const matrixError = (errcode: string, error: string) => ({
  errcode,
  error
})

/** The Matrix code of a request Fastify turned down before any route read it. */
function clientErrcode(status: number, code: string | undefined): string {
  if (
    code === 'FST_ERR_CTP_INVALID_JSON_BODY' ||
    code === 'FST_ERR_CTP_EMPTY_JSON_BODY'
  ) {
    return 'M_NOT_JSON'
  }
  return status === 413 ? 'M_TOO_LARGE' : 'M_UNKNOWN'
}

export function createServer(deps: {
  logger: Logger
  isReady: () => Promise<boolean>
}) {
  const app = Fastify({
    loggerInstance: deps.logger.child(
      {},
      {
        serializers: {
          req: (request: FastifyRequest) => ({
            method: request.method,
            url: request.url,
            remoteAddress: request.ip
          })
        }
      }
    ),
    logController: new LogController({
      disableRequestLogging: request => request.url.startsWith('/health/')
    })
  })

  app.setErrorHandler(
    (
      error: { statusCode?: number; code?: string; message: string },
      request,
      reply
    ) => {
      const status = error.statusCode ?? 500
      if (status < 500) {
        return reply
          .code(status)
          .send(matrixError(clientErrcode(status, error.code), error.message))
      }
      request.log.error({ err: error }, 'request failed')
      return reply.code(500).send(matrixError('M_UNKNOWN', 'Internal error'))
    }
  )

  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send(matrixError('M_UNRECOGNIZED', 'Unrecognized request'))
  )

  app.get('/health/live', (_request, reply) => reply.send({ status: 'ok' }))

  app.get('/health/ready', async (_request, reply) => {
    const ready = await deps.isReady().catch(() => false)
    return reply
      .code(ready ? 200 : 503)
      .send({ status: ready ? 'ok' : 'unavailable' })
  })

  return app
}

export type HttpServer = ReturnType<typeof createServer>
