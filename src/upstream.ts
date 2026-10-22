/** A service the token depends on failed: the caller gets a 502. */
export class UpstreamError extends Error {
  constructor(service: string, detail: string) {
    super(`${service}: ${detail}`)
    this.name = 'UpstreamError'
  }
}
