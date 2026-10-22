/** Every call to the homeserver, the directory or Meet gives up after this. */
export const UPSTREAM_TIMEOUT_MS = 5000

/** A service the token depends on failed: the caller gets a 502. */
export class UpstreamError extends Error {
  constructor(service: string, detail: string) {
    super(`${service}: ${detail}`)
    this.name = 'UpstreamError'
  }
}

/** The JSON body of an answer, or an `UpstreamError` that says which call failed. */
export async function readJson(
  service: string,
  path: string,
  response: Response
): Promise<Record<string, unknown>> {
  if (!response.ok) {
    throw new UpstreamError(
      service,
      `${path} answered ${String(response.status)}`
    )
  }
  const body: unknown = await response.json().catch(() => null)
  if (typeof body !== 'object' || body === null) {
    throw new UpstreamError(service, `${path} answered no JSON object`)
  }

  return body as Record<string, unknown>
}

/** `fetch`, with the timeout, and a network failure turned into an `UpstreamError`. */
export async function call(
  service: string,
  url: string,
  init: RequestInit = {}
): Promise<Response> {
  try {
    return await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
    })
  } catch (err) {
    throw new UpstreamError(
      service,
      `${new URL(url).pathname}: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}
