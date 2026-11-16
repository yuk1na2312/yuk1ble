/**
 * What every request must pass before a route sees it, and the HTTP helpers
 * the routes share.
 *
 * The API has no authentication: the loopback bind is the boundary. Two checks
 * keep a web page from reaching through it, which matters more now that a route
 * can type into a terminal:
 *   - Host: only loopback names (and the configured ENSEMBLE_HOST) are served.
 *     A DNS-rebinding page reaches 127.0.0.1 under its own hostname, so its
 *     requests carry that hostname and are refused.
 *   - Origin: a request that names an origin the CORS rule does not allow is
 *     refused for every method. A request with no Origin (the CLI, curl) is fine.
 */

import type http from 'http'

/** Request bodies larger than this are refused with 413. */
export const MAX_BODY_BYTES = 1_048_576

/** An error that is the client's fault and says which status to answer with. */
export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

const DEFAULT_CORS_ORIGIN_PATTERNS = [
  /^http:\/\/localhost(?::\d+)?$/i,
  /^http:\/\/127\.0\.0\.1(?::\d+)?$/i,
  /^http:\/\/\[::1\](?::\d+)?$/i,
]

function getAllowedCorsOrigins(): string[] {
  const configured = process.env.ENSEMBLE_CORS_ORIGIN?.trim()
  if (!configured) return []

  return configured
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean)
}

export function isAllowedOrigin(origin: string): boolean {
  const configuredOrigins = getAllowedCorsOrigins()
  if (configuredOrigins.length > 0) return configuredOrigins.includes(origin)
  return DEFAULT_CORS_ORIGIN_PATTERNS.some(pattern => pattern.test(origin))
}

export function buildCorsHeaders(origin?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  }

  if (origin && isAllowedOrigin(origin)) {
    headers['Access-Control-Allow-Origin'] = origin
  }

  return headers
}

export function sendJson(res: http.ServerResponse, data: unknown, status = 200, origin?: string): void {
  res.writeHead(status, buildCorsHeaders(origin))
  res.end(JSON.stringify(data))
}

/** `localhost:23000` -> `localhost`, `[::1]:23000` -> `[::1]`. Empty when the value is not a host[:port]. */
function hostWithoutPort(value: string): string {
  const match = /^(\[[^\]]+\]|[^:[\]]+)(?::\d{1,5})?$/.exec(value.trim().toLowerCase())
  return match ? match[1] : ''
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * True when a Host header names this machine's loopback, or the host the server
 * was deliberately bound to. A missing header is refused: every HTTP/1.1 client sends one.
 */
export function isAllowedHost(hostHeader: string | undefined, configuredHost?: string): boolean {
  if (!hostHeader) return false
  const host = hostWithoutPort(hostHeader)
  if (!host) return false
  if (LOOPBACK_HOSTS.has(host)) return true
  if (!configuredHost) return false
  const configured = configuredHost.trim().toLowerCase()
  return host === (configured.includes(':') && !configured.startsWith('[') ? `[${configured}]` : configured)
}

/** Why a request must be refused before routing, if it must. */
export function guardRequest(
  req: http.IncomingMessage,
  configuredHost?: string,
): { status: number; error: string } | undefined {
  if (!isAllowedHost(req.headers.host, configuredHost)) {
    return { status: 403, error: 'Host not allowed: this API answers to loopback names only' }
  }
  const origin = req.headers.origin
  if (origin && !isAllowedOrigin(origin)) {
    return { status: 403, error: 'CORS origin forbidden' }
  }
  return undefined
}

/** The request body as text. Rejects with HttpError 413 once it passes `limit` bytes, without buffering the rest. */
export function readBody(req: http.IncomingMessage, limit = MAX_BODY_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    const tooLarge = new HttpError(413, `Request body too large (max ${limit} bytes)`)
    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > limit) return reject(tooLarge)

    const chunks: Buffer[] = []
    let size = 0
    const onData = (chunk: Buffer): void => {
      size += chunk.length
      if (size > limit) {
        req.off('data', onData)
        chunks.length = 0
        reject(tooLarge)
        return
      }
      chunks.push(chunk)
    }
    req.on('data', onData)
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** The request body parsed as JSON. 400 for malformed JSON, 413 for a body over the limit. */
export async function readJsonBody(req: http.IncomingMessage, limit = MAX_BODY_BYTES): Promise<unknown> {
  const text = await readBody(req, limit)
  try {
    return JSON.parse(text)
  } catch {
    throw new HttpError(400, 'Bad Request: malformed JSON')
  }
}
