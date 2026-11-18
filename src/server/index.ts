/**
 * Ensemble Server — boot file: configuration, runtime, listen. The routes live
 * in lib/http-routes.ts, the request guard in lib/http-guard.ts.
 */

import http from 'http'
import { setRuntime } from '../runtime/agent-runtime'
import { PtyRuntime } from '../runtime/pty-runtime'
import { installLogCapture } from './log-buffer'
import { disbandLiveTeamsOnBoot } from '../core/store'
import { loadAgentsConfig } from '../adapters/agent-config'
import { createRequestHandler } from './routes'

installLogCapture()

// A bad ENSEMBLE_AGENTS_CONFIG must stop the server here, not at the first spawn.
try {
  const programs = Object.keys(loadAgentsConfig())
  console.log(`[Ensemble] Agent programs: ${programs.join(', ')}`)
} catch (err) {
  console.error(`[Ensemble] ${err instanceof Error ? err.message : err}`)
  process.exit(1)
}

setRuntime(new PtyRuntime())

const PORT = parseInt(process.env.ENSEMBLE_PORT || '23000', 10)
const HOST = process.env.ENSEMBLE_HOST || '127.0.0.1'

// Agent terminals inherit this environment and their `team-say` posts back to this
// server, so a server on a non-default port or host must tell its own agents where it is.
const clientHost = HOST === '0.0.0.0' || HOST === '::' ? '127.0.0.1' : HOST.includes(':') ? `[${HOST}]` : HOST
process.env.ENSEMBLE_URL ??= `http://${clientHost}:${PORT}`

const server = http.createServer(createRequestHandler({ host: HOST, port: PORT }))

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[Ensemble] Port ${PORT} is already in use on ${HOST}. Stop the other process or set ENSEMBLE_PORT to a different port.`)
    process.exit(1)
  }

  console.error('[Ensemble] Server failed to start:', err)
  process.exit(1)
})

// PTY sessions live in this process, so no team recorded as running before the
// start can still have its agents. Runs here, never in a CLI process.
const staleTeams = disbandLiveTeamsOnBoot()
if (staleTeams > 0) {
  console.log(`[Ensemble] Startup cleanup: marked ${staleTeams} team(s) from the previous run as disbanded`)
}

server.listen(PORT, HOST, () => {
  console.log(`[Ensemble] Server running on http://${HOST}:${PORT}`)
  console.log(`[Ensemble] Health: http://localhost:${PORT}/api/v1/health`)
})
