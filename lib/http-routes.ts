/**
 * The HTTP API: every route, behind the Host/Origin guard. server.ts boots it.
 */

import http from 'http'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  createEnsembleTeam, getEnsembleTeam, listEnsembleTeams,
  getTeamFeed, sendTeamMessage, disbandTeam,
} from '../services/ensemble-service'
import { getRuntime } from './agent-runtime'
import { getLogEntries } from './log-buffer'
import { describePrograms } from './programs'
import { buildCorsHeaders, guardRequest, HttpError, readJsonBody, sendJson } from './http-guard'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const UI_FILE = path.join(__dirname, '..', 'public', 'index.html')

/** How long a client may keep sending a refused body before its connection is cut. */
const BODY_DRAIN_MS = 2_000

export interface RequestHandlerOptions {
  /** The address the server is bound to; its name is accepted in the Host header. */
  host: string
  port: number
}

export function createRequestHandler({ host, port }: RequestHandlerOptions): http.RequestListener {
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

      // Feed: /api/ensemble/teams/:id/feed
      const feedMatch = pathname.match(/^\/api\/ensemble\/teams\/([^/]+)\/feed$/)
      if (feedMatch && method === 'GET') {
        return reply(getTeamFeed(feedMatch[1], url.searchParams.get('since') || undefined))
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

      // Monitoring UI
      if ((pathname === '/' || pathname === '/index.html') && method === 'GET') {
        try {
          const html = fs.readFileSync(UI_FILE)
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
          })
          res.end(html)
        } catch {
          json({ error: 'UI not found' }, 404)
        }
        return
      }

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
