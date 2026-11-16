/**
 * Server-Sent Events: the push side of the API.
 *
 *   GET /api/ensemble/events[?team=<id>]
 *       `team`    JSON EnsembleTeam      a team was created or changed
 *       `message` JSON EnsembleMessage   a message was appended (only ?team=<id>'s when given)
 *       `log`     JSON LogEntry          a line was written to the server console
 *
 *   GET /api/ensemble/sessions/:name/stream
 *       `replay`  base64 of the bounded raw scrollback, sent once, first
 *       `data`    base64 of the raw PTY output that followed, in order, batched
 *       `exit`    JSON {}                the session ended; the stream closes after it
 *
 * Every connection is bounded: MAX_SSE_CONNECTIONS in total, MAX_PENDING_BYTES
 * of unsent output per client (a slower client is dropped, never buffered
 * without limit), and everything it subscribed to is released the moment it closes.
 */

import type http from 'http'
import { bus } from './bus'
import { getRuntime } from './agent-runtime'
import { isAllowedOrigin, sendJson } from './http-guard'

export const MAX_SSE_CONNECTIONS = 32
export const HEARTBEAT_MS = 20_000
/** A client with more than this many bytes waiting to be sent is dropped. */
export const MAX_PENDING_BYTES = 1_048_576
/** PTY chunks arriving within this window leave as one `data` event. */
export const PTY_BATCH_MS = 16
/** A batch this large is sent at once instead of waiting for the window. */
const MAX_BATCH_CHARS = 256 * 1024

interface Stream {
  /** Write one event. False when the client is gone or was just dropped for being too slow. */
  send(event: string, data: string): boolean
  /** Run `fn` once, when the stream closes however it closes. */
  onClose(fn: () => void): void
  /** Finish the response and release the stream. */
  end(): void
}

const open = new Set<Stream>()

/** Streams currently open, for tests and diagnostics. */
export function sseConnectionCount(): number {
  return open.size
}

/** Answers 429 and returns false when no stream may be opened. */
function admit(res: http.ServerResponse, origin: string | undefined): boolean {
  if (open.size < MAX_SSE_CONNECTIONS) return true
  sendJson(res, { error: `Too many event streams open (max ${MAX_SSE_CONNECTIONS})` }, 429, origin)
  return false
}

function startStream(req: http.IncomingMessage, res: http.ServerResponse, origin: string | undefined): Stream {
  // A stream outlives every idle timeout the server would otherwise apply to a connection.
  req.socket.setTimeout(0)
  req.socket.setNoDelay(true)
  res.setTimeout(0)

  const headers: Record<string, string> = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Vary': 'Origin',
  }
  if (origin && isAllowedOrigin(origin)) headers['Access-Control-Allow-Origin'] = origin
  res.writeHead(200, headers)
  // `retry` tells EventSource how long to wait before reconnecting; the comment flushes the headers.
  res.write('retry: 2000\n: connected\n\n')

  const closers: Array<() => void> = []
  let closed = false

  const close = (): void => {
    if (closed) return
    closed = true
    clearInterval(heartbeat)
    open.delete(stream)
    for (const fn of closers.splice(0)) {
      try { fn() } catch { /* a cleanup that throws must not stop the others */ }
    }
  }

  const write = (text: string): boolean => {
    if (closed) return false
    if (res.writableLength > MAX_PENDING_BYTES) {
      res.destroy() // too slow to follow: drop it rather than hold its backlog
      close()
      return false
    }
    try {
      res.write(text)
      return true
    } catch {
      close()
      return false
    }
  }

  const heartbeat = setInterval(() => { write(': ping\n\n') }, HEARTBEAT_MS)
  heartbeat.unref()

  const stream: Stream = {
    send: (event, data) => write(`event: ${event}\ndata: ${data}\n\n`),
    onClose: fn => { if (closed) fn(); else closers.push(fn) },
    end: () => {
      if (closed) return
      close()
      res.end()
    },
  }
  open.add(stream)
  res.on('close', close)
  res.on('error', close)
  return stream
}

/** GET /api/ensemble/events */
export function handleEvents(
  req: http.IncomingMessage, res: http.ServerResponse, origin: string | undefined, teamId?: string,
): void {
  if (!admit(res, origin)) return
  const stream = startStream(req, res, origin)
  const unsubscribe = [
    bus.on('team', team => { stream.send('team', JSON.stringify(team)) }),
    bus.on('message', message => {
      if (!teamId || message.teamId === teamId) stream.send('message', JSON.stringify(message))
    }),
    bus.on('log', entry => { stream.send('log', JSON.stringify(entry)) }),
  ]
  stream.onClose(() => { for (const off of unsubscribe) off() })
}

const base64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64')

/** GET /api/ensemble/sessions/:name/stream */
export function handleSessionStream(
  req: http.IncomingMessage, res: http.ServerResponse, origin: string | undefined, sessionName: string,
): void {
  const runtime = getRuntime()
  if (!runtime.exists(sessionName)) return sendJson(res, { error: 'Session not found' }, 404, origin)
  if (!admit(res, origin)) return

  let batch = ''
  let batchTimer: ReturnType<typeof setTimeout> | undefined
  let stream: Stream | undefined = undefined // set once the headers are out, after the subscription

  const flush = (): void => {
    clearTimeout(batchTimer)
    batchTimer = undefined
    if (!batch || !stream) return
    const text = batch
    batch = ''
    stream.send('data', base64(text))
  }

  // Subscribe and take the replay in one synchronous step, so no output falls between the two.
  let offData: (() => void) | undefined
  let offExit: (() => void) | undefined
  let replay: string
  try {
    offData = runtime.onData(sessionName, chunk => {
      batch += chunk
      if (batch.length >= MAX_BATCH_CHARS) flush()
      else batchTimer ??= setTimeout(flush, PTY_BATCH_MS)
    })
    offExit = runtime.onExit(sessionName, () => {
      flush()
      stream?.send('exit', '{}')
      stream?.end()
    })
    replay = runtime.replay(sessionName)
  } catch (err) {
    offData?.()
    offExit?.()
    // The session went away since the check above, or has too many watchers already.
    const gone = !runtime.exists(sessionName)
    return sendJson(res, { error: gone ? 'Session not found' : (err instanceof Error ? err.message : String(err)) }, gone ? 404 : 429, origin)
  }

  stream = startStream(req, res, origin)
  stream.onClose(() => {
    clearTimeout(batchTimer)
    batch = ''
    offData?.()
    offExit?.()
  })
  stream.send('replay', base64(replay))
}
