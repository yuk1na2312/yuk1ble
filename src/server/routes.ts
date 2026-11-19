/**
 * The HTTP API: every route, behind the Host/Origin guard. index.ts boots it.
 */

import http from 'http'
import {
  createEnsembleTeam, getEnsembleTeam, listEnsembleTeams,
  getTeamFeed, sendTeamMessage, disbandTeam, archiveTeam, purgeTeam,
} from '../core/team-lifecycle'
import { getRuntime } from '../runtime/agent-runtime'
import { isLiveTeamSession } from '../core/store'
import { getLogEntries } from './log-buffer'
import { describePrograms } from '../adapters/programs'
import { listCollabTemplates } from '../core/prompts'
import { buildCorsHeaders, guardRequest, HttpError, readJsonBody, sendJson } from './guard'
import { handleEvents, handleSessionStream } from './sse'
import { serveStatic } from './static'

/** How long a client may keep sending a refused body before its connection is cut. */
const BODY_DRAIN_MS = 2_000

export interface RequestHandlerOptions {
  /** The address the server is bound to; its name is accepted in the Host header. */
  host: string
  port: number
  /** Directory served at `/` (default: web/). Tests point it at a temp dir. */
  webRoot?: string
}

const INPUT_ROUTE = /^\/api\/ensemble\/sessions\/([^/]+)\/(input|resize)$/

/** Raw keystrokes accepted per request. */
export const MAX_INPUT_BYTES = 65_536
const COLS = { min: 20, max: 400 }
const ROWS = { min: 5, max: 200 }

type RouteResult = { data?: unknown; error?: string; status: number }

/** Runs a runtime call on a session that existed a moment ago; one that has since gone is a 404. */
function onSession(sessionName: string, run: () => void): RouteResult | undefined {
  try {
    run()
    return undefined
  } catch {
    return getRuntime().exists(sessionName)
      ? { error: 'Could not reach the session', status: 500 }
      : { error: 'Session not found', status: 404 }
  }
}

function writeInput(sessionName: string, body: unknown): RouteResult {
  const data = (body as { data?: unknown } | null)?.data
  if (typeof data !== 'string' || data.length === 0) return { error: 'data must be a non-empty string', status: 400 }
  if (Buffer.byteLength(data, 'utf8') > MAX_INPUT_BYTES) {
    return { error: `data is larger than ${MAX_INPUT_BYTES} bytes`, status: 413 }
  }
  return onSession(sessionName, () => getRuntime().write(sessionName, data)) ?? { data: { ok: true }, status: 200 }
}

function resizeSession(sessionName: string, body: unknown): RouteResult {
  const { cols, rows } = (body ?? {}) as { cols?: unknown; rows?: unknown }
  const within = (value: unknown, range: { min: number; max: number }): value is number =>
    Number.isInteger(value) && (value as number) >= range.min && (value as number) <= range.max
  if (!within(cols, COLS) || !within(rows, ROWS)) {
    return { error: `cols and rows must be integers: cols ${COLS.min}-${COLS.max}, rows ${ROWS.min}-${ROWS.max}`, status: 400 }
  }
  return onSession(sessionName, () => getRuntime().resize(sessionName, cols, rows)) ?? { data: { ok: true, cols, rows }, status: 200 }
}

export function createRequestHandler({ host, port, webRoot }: RequestHandlerOptions): http.RequestListener {
  return async (req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${port}`)
    const pathname = url.pathname
    const method = req.method || 'GET'
    const origin = req.headers.origin
    const json = (data: unknown, status = 200): void => sendJson(res, data, status, origin)
    const reply = (result: { data?: unknown; error?: string; status: number }): void =>
      result.error ? json({ error: result.error }, result.status) : json(result.data, result.status)

    const refused = guardRequest(req, host)
    if (refused) return json({ error: refused.error }, refused.status)

    // CORS preflight
    if (method === 'OPTIONS') {
      res.writeHead(204, buildCorsHeaders(origin))
      res.end()
      return
    }

    try {
      // Health check
      if (pathname === '/api/v1/health') {
        return json({ status: 'healthy', version: '1.0.0' })
      }

      // Programs: the adapter catalog the GUI and CLI build their pickers from
      if (pathname === '/api/ensemble/programs' && method === 'GET') {
        return json(describePrograms())
      }

      // Templates: the collaboration presets the new-team form offers
      if (pathname === '/api/ensemble/templates' && method === 'GET') {
        return json(listCollabTemplates())
      }

      // List teams / Create team
      if (pathname === '/api/ensemble/teams') {
        if (method === 'GET') return reply(listEnsembleTeams())
        if (method === 'POST') return reply(await createEnsembleTeam(await readJsonBody(req)))
      }

      // Team operations: /api/ensemble/teams/:id
      const teamMatch = pathname.match(/^\/api\/ensemble\/teams\/([^/]+)$/)
      if (teamMatch) {
        const teamId = teamMatch[1]
        if (method === 'GET') return reply(getEnsembleTeam(teamId))
        if (method === 'POST') {
          const body = await readJsonBody(req) as Record<string, unknown>
          return reply(await sendTeamMessage(teamId, (body.to as string) || 'team', body.content as string, body.from as string, body.id as string, body.timestamp as string))
        }
        if (method === 'DELETE') return reply(await disbandTeam(teamId))
      }

      // Disband: /api/ensemble/teams/:id/disband
      const disbandMatch = pathname.match(/^\/api\/ensemble\/teams\/([^/]+)\/disband$/)
      if (disbandMatch && method === 'POST') return reply(await disbandTeam(disbandMatch[1]))

      // Archive / restore: /api/ensemble/teams/:id/archive  { archived: boolean }
      const archiveMatch = pathname.match(/^\/api\/ensemble\/teams\/([^/]+)\/archive$/)
      if (archiveMatch && method === 'POST') {
        const archived = (await readJsonBody(req) as { archived?: unknown } | null)?.archived
        if (typeof archived !== 'boolean') return json({ error: 'archived must be a boolean' }, 400)
        return reply(await archiveTeam(archiveMatch[1], archived))
      }

      // Purge an archived team for good: /api/ensemble/teams/:id/purge
      const purgeMatch = pathname.match(/^\/api\/ensemble\/teams\/([^/]+)\/purge$/)
      if (purgeMatch && method === 'POST') return reply(await purgeTeam(purgeMatch[1]))

      // Feed: /api/ensemble/teams/:id/feed
      const feedMatch = pathname.match(/^\/api\/ensemble\/teams\/([^/]+)\/feed$/)
      if (feedMatch && method === 'GET') {
        return reply(getTeamFeed(feedMatch[1], url.searchParams.get('since') || undefined))
      }

      // Push: team, message and log events, optionally one team's messages only
      if (pathname === '/api/ensemble/events' && method === 'GET') {
        return handleEvents(req, res, origin, url.searchParams.get('team') || undefined)
      }

      // Push: one session's terminal output, replay first then live chunks
      const streamMatch = pathname.match(/^\/api\/ensemble\/sessions\/([^/]+)\/stream$/)
      if (streamMatch && method === 'GET') {
        return handleSessionStream(req, res, origin, decodeURIComponent(streamMatch[1]))
      }

      // Typing into an agent's terminal: raw input, and the browser terminal's size
      const inputMatch = pathname.match(INPUT_ROUTE)
      if (inputMatch && method === 'POST') {
        const sessionName = decodeURIComponent(inputMatch[1])
        // Only an agent's terminal of a team still running. Checked before the body is read.
        if (!isLiveTeamSession(sessionName) || !getRuntime().exists(sessionName)) {
          return json({ error: 'Session not found' }, 404)
        }
        const body = await readJsonBody(req)
        return reply(inputMatch[2] === 'input' ? writeInput(sessionName, body) : resizeSession(sessionName, body))
      }

      // Live pane: /api/ensemble/sessions/:name/pane?lines=N
      // The monitoring UI's replacement for attaching a terminal to each agent.
      const paneMatch = pathname.match(/^\/api\/ensemble\/sessions\/([^/]+)\/pane$/)
      if (paneMatch && method === 'GET') {
        const sessionName = decodeURIComponent(paneMatch[1])
        const requested = Number(url.searchParams.get('lines'))
        const lines = Number.isFinite(requested) && requested > 0 ? Math.min(requested, 500) : 60
        const runtime = getRuntime()
        const exists = runtime.exists(sessionName)
        const pane = exists ? runtime.screen(sessionName, lines) : ''
        return json({ session: sessionName, exists, pane })
      }

      // Server console stream: /api/ensemble/logs?since=<seq>
      if (pathname === '/api/ensemble/logs' && method === 'GET') {
        const since = Number(url.searchParams.get('since'))
        return json(getLogEntries(Number.isFinite(since) ? since : undefined))
      }

      // Last: anything that is not an API route may be a GUI file
      if (await serveStatic(req, res, pathname, { webRoot })) return

      json({ error: 'Not found' }, 404)
    } catch (err) {
      if (err instanceof HttpError) {
        if (err.status === 413) {
          // The rest of the body is still coming. Answer, drop it unread and close, and
          // stop listening to a client that keeps sending anyway: closing a socket that
          // still has unread data resets it, and the client would never see the 413.
          res.setHeader('Connection', 'close')
          req.resume()
          const cutoff = setTimeout(() => req.destroy(), BODY_DRAIN_MS)
          res.once('close', () => clearTimeout(cutoff))
        }
        return json({ error: err.message }, err.status)
      }
      console.error('[Server] Error:', err)
      json({ error: 'Internal server error' }, 500)
    }
  }
}
