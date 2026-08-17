/**
 * Ensemble Server — Standalone HTTP server
 * Lightweight replacement for Next.js API routes.
 */

import http from 'http'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  createEnsembleTeam, getEnsembleTeam, listEnsembleTeams,
  getTeamFeed, sendTeamMessage, disbandTeam, archiveTeam, purgeTeam,
  invokeAgentSkill, resolveAgentProjectDir,
} from './services/ensemble-service'
import { getRuntime, setRuntime } from './lib/agent-runtime'
import { PtyRuntime } from './lib/pty-runtime'
import { installLogCapture, getLogEntries } from './lib/log-buffer'
import { getAccountStatuses } from './lib/account-status'
import { getSkillCatalog } from './lib/skill-catalog'

installLogCapture()
setRuntime(new PtyRuntime())

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = path.join(__dirname, 'public')

// Static files served from public/: extension allowlist. The HTTP API has no
// auth (loopback by design, see AGENTS.md), so anything not on this list —
// server.ts, .env, agents.json — must never be reachable, even if it lives
// inside public/.
const STATIC_CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.woff2': 'font/woff2',
}

/**
 * Resolves a request path to an absolute file path inside PUBLIC_DIR, or
 * null if it must be refused. Pure path arithmetic — no filesystem access —
 * so it's unit-testable without fixtures and shared by the request handler.
 *
 * `/` maps to index.html. Everything else is decoded, stripped of its
 * leading slash(es), and resolved against PUBLIC_DIR with path.resolve —
 * which on Windows treats `\` the same as `/`, so `..\` traversal is closed
 * by the same check as `../`. The result must land inside PUBLIC_DIR
 * (containment check) and carry an allowlisted extension, or it's rejected.
 * Percent-decode failures (malformed `%` sequences) are caught, not thrown.
 */
export function resolveStaticFile(urlPath: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(urlPath)
  } catch {
    return null
  }

  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^[/\\]+/, '')
  const resolved = path.resolve(PUBLIC_DIR, relative)

  const withinPublicDir = resolved === PUBLIC_DIR || resolved.startsWith(PUBLIC_DIR + path.sep)
  if (!withinPublicDir) return null

  const ext = path.extname(resolved).toLowerCase()
  if (!(ext in STATIC_CONTENT_TYPES)) return null

  return resolved
}

export function staticContentType(filePath: string): string {
  return STATIC_CONTENT_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream'
}

const PORT = parseInt(process.env.ENSEMBLE_PORT || process.env.ORCHESTRA_PORT || '23000', 10)
const HOST = process.env.ENSEMBLE_HOST || '127.0.0.1'
const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX_REQUESTS = 100
const DEFAULT_CORS_ORIGIN_PATTERNS = [
  /^http:\/\/localhost(?::\d+)?$/i,
  /^http:\/\/127\.0\.0\.1(?::\d+)?$/i,
  /^http:\/\/\[::1\](?::\d+)?$/i,
]

type RateLimitEntry = {
  count: number
  windowStart: number
}

const rateLimitByIp = new Map<string, RateLimitEntry>()

// Periodic cleanup of stale rate limit entries to prevent unbounded Map growth
setInterval(() => {
  const now = Date.now()
  for (const [ip, entry] of rateLimitByIp) {
    if (now - entry.windowStart >= RATE_LIMIT_WINDOW_MS) {
      rateLimitByIp.delete(ip)
    }
  }
}, 60_000)

function getAllowedCorsOrigins(): string[] {
  const configured = process.env.ENSEMBLE_CORS_ORIGIN?.trim()
  if (!configured) return []

  return configured
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean)
}

function isAllowedOrigin(origin: string): boolean {
  const configuredOrigins = getAllowedCorsOrigins()
  if (configuredOrigins.length > 0) return configuredOrigins.includes(origin)
  return DEFAULT_CORS_ORIGIN_PATTERNS.some(pattern => pattern.test(origin))
}

function buildCorsHeaders(origin?: string): Record<string, string> {
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

function json(res: http.ServerResponse, data: unknown, status = 200, origin?: string) {
  res.writeHead(status, buildCorsHeaders(origin))
  res.end(JSON.stringify(data))
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', chunk => body += chunk)
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

function getClientIp(req: http.IncomingMessage): string {
  const forwardedFor = req.headers['x-forwarded-for']
  if (typeof forwardedFor === 'string') {
    const firstIp = forwardedFor.split(',')[0]?.trim()
    if (firstIp) return firstIp
  }

  return req.socket.remoteAddress || 'unknown'
}

function isRateLimited(ip: string): boolean {
  const now = Date.now()
  const current = rateLimitByIp.get(ip)

  if (!current || now - current.windowStart >= RATE_LIMIT_WINDOW_MS) {
    rateLimitByIp.set(ip, { count: 1, windowStart: now })
    return false
  }

  current.count += 1
  return current.count > RATE_LIMIT_MAX_REQUESTS
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`)
  const path = url.pathname
  const method = req.method || 'GET'
  const origin = req.headers.origin

  if (origin && !isAllowedOrigin(origin)) {
    return json(res, { error: 'CORS origin forbidden' }, 403, origin)
  }

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, buildCorsHeaders(origin))
    res.end()
    return
  }

  try {
    // Health check — always exempt from rate limiting
    if (path === '/api/v1/health') {
      return json(res, { status: 'healthy', version: '1.0.0' }, 200, origin)
    }

    // Internal ensemble API routes are exempt from rate limiting
    const isInternalEnsembleApi = path.startsWith('/api/ensemble/')
    if (!isInternalEnsembleApi && isRateLimited(getClientIp(req))) {
      return json(res, { error: 'Rate limit exceeded' }, 429, origin)
    }

    // List teams / Create team
    if (path === '/api/ensemble/teams') {
      if (method === 'GET') {
        const result = listEnsembleTeams()
        return json(res, result.data, result.status, origin)
      }
      if (method === 'POST') {
        let body: unknown
        try {
          body = JSON.parse(await readBody(req))
        } catch {
          return json(res, { error: 'Bad Request: malformed JSON' }, 400, origin)
        }
        const result = await createEnsembleTeam(body as Parameters<typeof createEnsembleTeam>[0])
        if (result.error) return json(res, { error: result.error }, result.status, origin)
        return json(res, result.data, result.status, origin)
      }
    }

    // Team operations: /api/ensemble/teams/:id
    const teamMatch = path.match(/^\/api\/ensemble\/teams\/([^/]+)$/)
    if (teamMatch) {
      const teamId = teamMatch[1]
      if (method === 'GET') {
        const result = getEnsembleTeam(teamId)
        if (result.error) return json(res, { error: result.error }, result.status, origin)
        return json(res, result.data, result.status, origin)
      }
      if (method === 'POST') {
        let body: Record<string, unknown>
        try {
          body = JSON.parse(await readBody(req))
        } catch {
          return json(res, { error: 'Bad Request: malformed JSON' }, 400, origin)
        }
        const result = await sendTeamMessage(teamId, (body.to as string) || 'team', body.content as string, body.from as string, body.id as string, body.timestamp as string)
        if (result.error) return json(res, { error: result.error }, result.status, origin)
        return json(res, result.data, result.status, origin)
      }
      if (method === 'DELETE') {
        const result = await disbandTeam(teamId)
        if (result.error) return json(res, { error: result.error }, result.status, origin)
        return json(res, result.data, result.status, origin)
      }
    }

    // Disband: /api/ensemble/teams/:id/disband
    const disbandMatch = path.match(/^\/api\/ensemble\/teams\/([^/]+)\/disband$/)
    if (disbandMatch && method === 'POST') {
      const result = await disbandTeam(disbandMatch[1])
      if (result.error) return json(res, { error: result.error }, result.status, origin)
      return json(res, result.data, result.status, origin)
    }

    // Archive / unarchive: /api/ensemble/teams/:id/archive
    const archiveMatch = path.match(/^\/api\/ensemble\/teams\/([^/]+)\/archive$/)
    if (archiveMatch && method === 'POST') {
      let body: Record<string, unknown>
      try {
        body = JSON.parse(await readBody(req))
      } catch {
        return json(res, { error: 'Bad Request: malformed JSON' }, 400, origin)
      }
      const result = await archiveTeam(archiveMatch[1], Boolean(body.archived))
      if (result.error) return json(res, { error: result.error }, result.status, origin)
      return json(res, result.data, result.status, origin)
    }

    // Purge: /api/ensemble/teams/:id/purge
    const purgeMatch = path.match(/^\/api\/ensemble\/teams\/([^/]+)\/purge$/)
    if (purgeMatch && method === 'POST') {
      const result = await purgeTeam(purgeMatch[1])
      if (result.error) return json(res, { error: result.error }, result.status, origin)
      return json(res, result.data, result.status, origin)
    }

    // Fire an installed skill at one agent: /api/ensemble/teams/:id/skill
    // Own regex, deliberately not folded into the bare POST /teams/:id
    // handler above — that one is the plain-message path (sendTeamMessage)
    // and stays exactly as it is. See design doc §5.2 / §6.
    const skillMatch = path.match(/^\/api\/ensemble\/teams\/([^/]+)\/skill$/)
    if (skillMatch && method === 'POST') {
      let body: Record<string, unknown>
      try {
        body = JSON.parse(await readBody(req))
      } catch {
        return json(res, { error: 'Bad Request: malformed JSON' }, 400, origin)
      }
      const token = body.token
      if (typeof token !== 'string' || token.length === 0) {
        return json(res, { error: 'token is required' }, 400, origin)
      }
      const agentName = typeof body.agent === 'string' ? body.agent : ''
      const args = typeof body.args === 'string' ? body.args : ''
      const result = await invokeAgentSkill(skillMatch[1], agentName, token, args)
      if (result.error) return json(res, { error: result.error }, result.status, origin)
      return json(res, result.data, result.status, origin)
    }

    // Feed: /api/ensemble/teams/:id/feed
    const feedMatch = path.match(/^\/api\/ensemble\/teams\/([^/]+)\/feed$/)
    if (feedMatch && method === 'GET') {
      const since = url.searchParams.get('since') || undefined
      const result = getTeamFeed(feedMatch[1], since)
      if (result.error) return json(res, { error: result.error }, result.status, origin)
      return json(res, result.data, result.status, origin)
    }

    // Live pane: /api/ensemble/sessions/:name/pane?lines=N
    // The monitoring UI's replacement for attaching a terminal to each agent.
    const paneMatch = path.match(/^\/api\/ensemble\/sessions\/([^/]+)\/pane$/)
    if (paneMatch && method === 'GET') {
      const sessionName = decodeURIComponent(paneMatch[1])
      const requested = Number(url.searchParams.get('lines'))
      const lines = Number.isFinite(requested) && requested > 0 ? Math.min(requested, 500) : 60
      const runtime = getRuntime()
      const exists = await runtime.sessionExists(sessionName)
      const pane = exists ? await runtime.capturePane(sessionName, lines) : ''
      return json(res, { session: sessionName, exists, pane }, 200, origin)
    }

    // Server console stream: /api/ensemble/logs?since=<seq>
    if (path === '/api/ensemble/logs' && method === 'GET') {
      const since = Number(url.searchParams.get('since'))
      return json(res, getLogEntries(Number.isFinite(since) ? since : undefined), 200, origin)
    }

    // Read-only account status for each agent CLI: /api/ensemble/accounts
    // Strictly GET — no login/logout route belongs here. The HTTP API has no
    // auth (loopback by design), so a logout route would be an unauthenticated
    // curl that ends a paid subscription session. See design doc "Non-goals".
    if (path === '/api/ensemble/accounts' && method === 'GET') {
      return json(res, await getAccountStatuses(), 200, origin)
    }

    // Installed-skill catalog for one agent: /api/ensemble/skills?team=<id>&agent=<name>
    // team + agent only — NEVER a filesystem path. The project directory is
    // derived server-side from registry state (the agent's worktreePath if
    // set, else the team's workingDirectory) so a caller on the loopback
    // interface can't turn this into an arbitrary-directory reader on an API
    // that has no auth by design. See design doc §5 / §9.
    if (path === '/api/ensemble/skills' && method === 'GET') {
      const teamId = url.searchParams.get('team') || ''
      const agentName = url.searchParams.get('agent') || ''
      const teamResult = getEnsembleTeam(teamId)
      if (teamResult.error) return json(res, { error: teamResult.error }, teamResult.status, origin)
      const team = teamResult.data!.team
      const agent = team.agents.find(a => a.name === agentName)
      if (!agent) return json(res, { error: 'Agent not found' }, 404, origin)
      const catalog = await getSkillCatalog(agent.program, resolveAgentProjectDir(team, agent))
      return json(res, catalog, 200, origin)
    }

    // Monitoring UI + static assets: the whole public/ tree (index.html,
    // app.css, js/*, vendor/*). Matched last among GET routes, after every
    // /api/... route above, so it can never shadow the API. See
    // resolveStaticFile() for the containment + extension-allowlist logic.
    if (method === 'GET') {
      const resolved = resolveStaticFile(path)
      if (resolved) {
        try {
          if (!fs.statSync(resolved).isFile()) throw new Error('not a file')
          const contents = fs.readFileSync(resolved)
          res.writeHead(200, {
            'Content-Type': staticContentType(resolved),
            'Cache-Control': 'no-store',
          })
          res.end(contents)
        } catch {
          json(res, { error: 'Not found' }, 404, origin)
        }
        return
      }
    }

    json(res, { error: 'Not found' }, 404, origin)
  } catch (err) {
    console.error('[Server] Error:', err)
    json(res, { error: 'Internal server error' }, 500, origin)
  }
})

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[Ensemble] Port ${PORT} is already in use on ${HOST}. Stop the other process or set ENSEMBLE_PORT to a different port.`)
    process.exit(1)
  }

  console.error('[Ensemble] Server failed to start:', err)
  process.exit(1)
})

server.listen(PORT, HOST, () => {
  console.log(`[Ensemble] Server running on http://${HOST}:${PORT}`)
  console.log(`[Ensemble] Health: http://localhost:${PORT}/api/v1/health`)
})
