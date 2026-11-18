#!/usr/bin/env tsx
/**
 * ensemble — CLI entrypoint
 *
 * Usage:
 *   ensemble run "task" [--agents x,y]      Run headless (no Claude Code needed)
 *   ensemble teams                          List all teams
 *   ensemble steer <team-id> <message>      Send a message to a team
 *   ensemble team-say <team-id> <from> <to> <message>
 *   ensemble team-read <team-id>
 *   ensemble status                         Server health + active teams
 *
 * A pure HTTP client. It must never load the runtime or the store: PTY sessions
 * live in the server process, and a second registry here would always be empty.
 */

import http from 'http'
import fs from 'fs'
import { spawn } from 'child_process'
import path from 'path'
import { REPO_ROOT } from '../repo-root'
import type { EnsembleMessage } from '../types'

const API_BASE = process.env.ENSEMBLE_URL || `http://localhost:${process.env.ENSEMBLE_PORT || '23000'}`

// Resolve package root (works both in dev and when installed via npm)
const ENSEMBLE_ROOT = process.env.ENSEMBLE_ROOT || REPO_ROOT
const SERVER_ENTRY = path.join(ENSEMBLE_ROOT, 'src', 'server', 'index.ts')

function findTsx(): string {
  // Check local node_modules first (npm installed package)
  const local = path.join(ENSEMBLE_ROOT, 'node_modules', '.bin', 'tsx')
  if (fs.existsSync(local)) return local
  // Fall back to global tsx
  return 'tsx'
}

// ANSI
const c = {
  r: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', cyan: '\x1b[36m', gray: '\x1b[90m',
  bWhite: '\x1b[97m', bGreen: '\x1b[92m', bBlue: '\x1b[94m', bYellow: '\x1b[93m',
  bgBlue: '\x1b[44m', bgGreen: '\x1b[42m',
}

function apiGet<T>(urlPath: string): Promise<T> {
  return new Promise((resolve, reject) => {
    http.get(`${API_BASE}${urlPath}`, { timeout: 3000 }, res => {
      let d = ''
      res.on('data', chunk => d += chunk)
      res.on('end', () => { try { resolve(JSON.parse(d)) } catch(e) { reject(e) } })
    }).on('error', reject)
  })
}

interface ProgramInfo { name: string; color: string; installed: boolean }

/** The server's program catalog; empty when it cannot be read. */
async function fetchPrograms(): Promise<ProgramInfo[]> {
  try {
    return await apiGet<ProgramInfo[]>('/api/ensemble/programs')
  } catch {
    return []
  }
}

/** "#rrggbb" as a 24-bit ANSI foreground. */
function hexToAnsi(hex: string): string {
  const n = parseInt(hex.slice(1), 16)
  return `\x1b[38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m`
}

function apiPost(urlPath: string, body: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const req = http.request(`${API_BASE}${urlPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)) },
      timeout: 5000,
    }, res => {
      let d = ''
      res.on('data', chunk => d += chunk)
      res.on('end', () => { try { resolve(JSON.parse(d)) } catch(e) { reject(e) } })
    })
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}

// ─── Commands ───

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 5000): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Post a message to the server, which records it and delivers it to the
 * recipient's terminal in the background. Agents rely on the exact "Sent to <recipient>" line, and
 * on a non-zero exit when the message did not go out (server down, unknown team).
 */
async function cmdTeamSay(teamId: string, from: string, to: string, content: string): Promise<void> {
  const endpoint = `${API_BASE}/api/ensemble/teams/${encodeURIComponent(teamId)}`
  let response: Response
  try {
    // The server answers as soon as the message is in the feed; pasting it into the terminal goes on behind.
    response = await fetchWithTimeout(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, content }),
    }, 15_000)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    console.error(`team-say failed: cannot reach the ensemble server at ${API_BASE} (${reason}). Is it running? (npm run dev)`)
    process.exitCode = 1
    return
  }

  if (!response.ok) {
    const detail = await response.json().then((b: { error?: string }) => b.error, () => undefined)
    console.error(`team-say failed: HTTP ${response.status}${detail ? ` ${detail}` : ''}`)
    process.exitCode = 1
    return
  }

  console.log(`Sent to ${to}`)
}

async function cmdTeamRead(teamId: string): Promise<void> {
  const response = await fetch(`${API_BASE}/api/ensemble/teams/${encodeURIComponent(teamId)}/feed`)
  if (!response.ok) {
    throw new Error(`Failed to read team feed: HTTP ${response.status}`)
  }

  const data = await response.json() as { messages?: EnsembleMessage[] }
  for (const message of data.messages || []) {
    console.log(`${message.from} -> ${message.to}: ${message.content}`)
  }
}

async function cmdStatus() {
  try {
    const health = await apiGet<{ status: string; version: string }>('/api/v1/health')
    const teams = await apiGet<{ teams: Array<{ status: string }> }>('/api/ensemble/teams')
    const active = teams.teams.filter(t => t.status === 'active')

    console.log()
    console.log(`  ${c.bold}${c.bWhite}◈ ensemble${c.r} ${c.dim}v${health.version}${c.r}`)
    console.log(`  ${c.bGreen}●${c.r} Server healthy at ${c.dim}${API_BASE}${c.r}`)
    console.log()
    console.log(`  ${c.bold}Teams:${c.r} ${teams.teams.length} total, ${c.bGreen}${active.length} active${c.r}`)
    console.log()
  } catch {
    console.log(`\n  ${c.red}●${c.r} Cannot connect to ${API_BASE}`)
    console.log(`  ${c.dim}Run: ensemble start${c.r}\n`)
  }
}

interface TeamListItem {
  id: string
  name: string
  description: string
  status: string
  createdAt: string
  agents: Array<{ name: string; program: string }>
}

async function cmdTeams() {
  try {
    const data = await apiGet<{ teams: TeamListItem[] }>('/api/ensemble/teams')
    const programs = await fetchPrograms()

    if (data.teams.length === 0) {
      console.log(`\n  ${c.yellow}No teams found.${c.r}\n`)
      return
    }

    console.log()
    console.log(`  ${c.bold}${c.bWhite}◈ ensemble teams${c.r}`)
    console.log()

    for (const t of data.teams) {
      const statusIcon = t.status === 'active' ? `${c.bGreen}●`
        : t.status === 'disbanded' ? `${c.red}○`
        : `${c.yellow}◌`

      const agents = t.agents.map(a => {
        // Cosmetic only: the leading word of the program string picks its colour.
        const program = programs.find(p => a.program.toLowerCase().startsWith(p.name))
        const col = program ? hexToAnsi(program.color) : c.bGreen
        return `${col}${a.name}${c.r}`
      }).join(' + ')

      const time = new Date(t.createdAt).toLocaleTimeString('en-US', {
        hour: '2-digit', minute: '2-digit', hour12: false,
      })

      console.log(
        `  ${statusIcon}${c.r} ${c.bold}${t.name}${c.r}` +
        `  ${agents}` +
        `  ${c.dim}${time}${c.r}` +
        `  ${c.gray}${t.id.slice(0, 8)}${c.r}`
      )
      console.log(`    ${c.dim}${t.description.slice(0, 80)}${c.r}`)
      console.log()
    }
  } catch {
    console.log(`\n  ${c.red}Cannot connect to ensemble server.${c.r}\n`)
  }
}

async function cmdSteer(teamId: string, message: string) {
  try {
    await apiPost(`/api/ensemble/teams/${teamId}`, {
      from: 'user',
      to: 'team',
      content: message,
    })
    console.log(`${c.bGreen}✓${c.r} Message sent to team`)
  } catch {
    console.log(`${c.red}✗${c.r} Failed to send message`)
  }
}

async function cmdRun(task: string, agentFlags: string | undefined, timeoutSec: number) {
  const cwd = process.cwd()

  // 1. Ensure server is running
  let serverProc: ReturnType<typeof spawn> | null = null
  try {
    await apiGet('/api/v1/health')
  } catch {
    process.stderr.write(`  ${c.dim}Starting server...${c.r}\n`)
    serverProc = spawn(findTsx(), [SERVER_ENTRY], {
      cwd: ENSEMBLE_ROOT, stdio: 'ignore', detached: true,
    })
    serverProc.unref()
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 1000))
      try { await apiGet('/api/v1/health'); break } catch { /* waiting */ }
    }
    try { await apiGet('/api/v1/health') } catch {
      console.error(`  ${c.red}Server failed to start${c.r}`)
      process.exit(1)
    }
  }

  // 2. Parse agents. Default: the first two installed programs, in agents.json order.
  let agentNames: string[]
  if (agentFlags) {
    agentNames = agentFlags.split(',').map(s => s.trim()).filter(Boolean)
  } else {
    agentNames = (await fetchPrograms()).filter(p => p.installed).slice(0, 2).map(p => p.name)
    if (agentNames.length < 2) {
      console.error(`  ${c.red}Fewer than two agent CLIs found on PATH.${c.r} Install one more or pass --agents <program>,<program> (see GET /api/ensemble/programs).`)
      process.exit(1)
    }
  }
  // `program` or `program:model`; the model is checked by the server against that program's catalog.
  const agents = agentNames.map((spec, i) => {
    const colon = spec.indexOf(':')
    const model = colon < 0 ? '' : spec.slice(colon + 1).trim()
    return {
      program: colon < 0 ? spec : spec.slice(0, colon).trim(),
      ...(model ? { model } : {}),
      role: i === 0 ? 'lead' : 'worker',
    }
  })

  // 3. Create team. The server answers 202 as soon as the team record exists;
  // agents are spawned and prompted in the background and report through the feed.
  const teamName = `run-${Date.now()}`
  const result = await apiPost('/api/ensemble/teams', {
    name: teamName,
    description: task,
    agents,
    feedMode: 'live',
    workingDirectory: cwd,
  }) as { team?: { id: string }; error?: string }

  if (!result.team) {
    console.error(`  ${c.red}Could not create the team:${c.r} ${result.error ?? 'unexpected response'}`)
    process.exit(1)
  }
  const teamId = result.team.id

  console.log(`\n  ${c.bold}${c.bWhite}◈ ensemble run${c.r}`)
  console.log(`  ${c.dim}${task.slice(0, 100)}${c.r}`)
  console.log(`  ${c.bGreen}●${c.r} Team ${c.dim}${teamId.slice(0, 8)}${c.r} created with ${agentNames.join(' + ')} ${c.dim}(agents are starting)${c.r}`)
  console.log(`  ${c.dim}Timeout: ${timeoutSec}s${c.r}\n`)

  // 4. Follow the team's feed over HTTP until it is disbanded or the timeout hits.
  // A run ends when the team does (sentinel, manual disband or idle) — never on
  // wording in a message.
  const deadline = Date.now() + timeoutSec * 1000
  let since = 0

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 3000))

    try {
      const feed = await apiGet<{ messages: EnsembleMessage[] }>(
        `/api/ensemble/teams/${teamId}/feed?since=${since}`,
      )
      for (const msg of feed.messages) {
        console.log(`  ${c.cyan}${msg.from || '?'}${c.r}: ${(msg.content || '').slice(0, 200)}`)
        since = Math.max(since, msg.seq ?? 0)
      }

      const team = await apiGet<{ team: { status: string } }>(`/api/ensemble/teams/${teamId}`)
      if (team.team.status === 'disbanded') {
        console.log(`\n  ${c.bGreen}✓${c.r} Team finished (disbanded)`)
        process.exit(0)
      }
    } catch { /* server busy; try again */ }
  }

  console.log(`\n  ${c.yellow}⏱${c.r} Timeout reached (${timeoutSec}s)`)
  process.exit(124)
}

// ─── Main ───

const [cmd, ...args] = process.argv.slice(2)

switch (cmd) {
  case 'team-say':
    if (args.length < 4) {
      console.error('Usage: ensemble team-say <team-id> <from> <to> <message>')
      process.exitCode = 1
      break
    }
    await cmdTeamSay(args[0], args[1], args[2], args.slice(3).join(' '))
    break
  case 'team-read':
    if (args.length !== 1) {
      console.error('Usage: ensemble team-read <team-id>')
      process.exitCode = 1
      break
    }
    await cmdTeamRead(args[0])
    break
  case 'teams':
  case 'ls':
    await cmdTeams()
    break
  case 'status':
  case 'health':
    await cmdStatus()
    break
  case 'run': {
    const runArgs = [...args]
    let agentList: string | undefined
    let timeout = 600
    // Parse --agents and --timeout flags
    for (let i = 0; i < runArgs.length; i++) {
      if (runArgs[i] === '--agents' && runArgs[i + 1]) {
        agentList = runArgs.splice(i, 2)[1]; i--
      } else if (runArgs[i] === '--timeout' && runArgs[i + 1]) {
        timeout = parseInt(runArgs.splice(i, 2)[1], 10); i--
      }
    }
    const taskDesc = runArgs.join(' ')
    if (!taskDesc) {
      console.log(`Usage: ensemble run "task description" [--agents <program>[:<model>],...] [--timeout 600]`)
      process.exit(1)
    }
    await cmdRun(taskDesc, agentList, timeout)
    break
  }
  case 'steer':
  case 'send':
    if (args.length < 2) {
      console.log(`Usage: ensemble steer <team-id> <message>`)
      process.exit(1)
    }
    await cmdSteer(args[0], args.slice(1).join(' '))
    break
  case 'start':
  case 'server': {
    try {
      await apiGet('/api/v1/health')
      console.log(`  ${c.bGreen}●${c.r} Server already running at ${c.dim}${API_BASE}${c.r}`)
    } catch {
      console.log(`  ${c.dim}Starting ensemble server...${c.r}`)
      const srv = spawn(findTsx(), [SERVER_ENTRY], {
        cwd: ENSEMBLE_ROOT, stdio: 'inherit',
      })
      srv.on('exit', code => process.exit(code || 0))
      // Keep alive
      await new Promise(() => {})
    }
    break
  }
  case 'help':
  case '--help':
  case '-h':
  case undefined:
    console.log(`
  ${c.bold}${c.bWhite}◈ ensemble${c.r} — multi-agent collaboration engine

  ${c.bold}Commands:${c.r}
    ${c.bWhite}start${c.r}                      Start the ensemble server
    ${c.bWhite}run${c.r} "task" [--agents ..]   Run headless (auto-starts server)
    ${c.bWhite}teams${c.r}                      List all teams
    ${c.bWhite}steer${c.r} <id> <message>       Send steering message to team
    ${c.bWhite}team-say${c.r} <id> <from> <to> <message>
    ${c.bWhite}team-read${c.r} <id>              Read the team message feed
    ${c.bWhite}status${c.r}                     Server health & overview

  ${c.bold}Examples:${c.r}
    ${c.dim}ensemble run "refactor auth module" --agents <program>:<model>,<program>${c.r}
    ${c.dim}ensemble run "fix all lint errors" --timeout 300${c.r}
    ${c.dim}ensemble steer abc123 "focus on security review"${c.r}
    ${c.dim}ensemble teams${c.r}
`)
    break
  default:
    console.log(`Unknown command: ${cmd}. Try: ensemble help`)
    process.exit(1)
}
