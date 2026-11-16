/**
 * Ensemble Service — Standalone
 * No dependency on ai-maestro's agent-registry or agents-core-service.
 * Uses agent-spawner.ts for local agent lifecycle.
 */

import { randomUUID } from 'crypto'
import type { EnsembleTeam, EnsembleMessage, CreateTeamRequest, CollabTemplatesFile } from '../types/ensemble'
import {
  createTeam, getTeam, updateTeam, loadTeams,
  appendMessage, getMessages,
} from '../lib/ensemble-registry'
import {
  spawnLocalAgent, killLocalAgent,
  getAgentTokenUsage,
} from '../lib/agent-spawner'
import { getRuntime } from '../lib/agent-runtime'
import { getFeedFile } from '../lib/ensemble-paths'
import { ensureSubmitted } from '../lib/paste-submit'
import { resolveAgentProgram, resolveReadyMarkers } from '../lib/agent-config'
import { matchReadyMarker, isQuiescentReady } from '../lib/pane-readiness'
import { AgentWatchdog } from '../lib/agent-watchdog'
import {
  collabPromptFile, collabDeliveryFile, collabSummaryFile,
  collabRuntimeDir, collabFinishedMarker, collabBridgePosted,
  collabBridgeResult, collabBridgeLog, collabBridgePid,
  ensureCollabDirs, scrubCollabRuntimePaths,
} from '../lib/collab-paths'
import fs from 'fs'
import path from 'path'
import { execFile, spawn } from 'child_process'
import { killProcessTree, killProcessTreeSync } from '../lib/win-process'
import { fileURLToPath } from 'url'
import { createWorktree, mergeWorktree, destroyWorktree, type WorktreeInfo } from '../lib/worktree-manager'
import { runStagedWorkflow } from '../lib/staged-workflow'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')

interface ServiceResult<T> {
  data?: T
  error?: string
  status: number
}

const IDLE_CHECK_INTERVAL_MS = 15_000
// How long a freshly spawned agent CLI may take to reach its input prompt.
// 60s is not enough for a Claude Code with a heavy MCP/plugin/hook stack —
// loading a large session context routinely runs past a minute on a cold start.
const READY_TIMEOUT_MS = Math.max(
  5_000,
  Number(process.env.ENSEMBLE_READY_TIMEOUT_MS) || 150_000
)
// How long a team may sit with no agent message before it is auto-disbanded.
// Long on purpose: agents routinely go quiet for many minutes while running a
// build, a test suite, or a long review, and disbanding mid-thought throws away
// live sessions the user is still watching. The short, fuzzy "someone said
// done" heuristic that used to end runs seconds after a closing remark is gone
// — a run now ends when the agents send the explicit sentinel, when the user
// disbands, or when it has genuinely gone idle for this long.
const IDLE_DISBAND_MS = Math.max(
  60_000,
  Number(process.env.ENSEMBLE_IDLE_DISBAND_MS) || 3_600_000
)
// Unchanged-screen window that stands in for an unrecognised ready marker.
const QUIESCENT_READY_MS = 20_000
const MIN_MESSAGES_BEFORE_AUTO_DISBAND = 10
// Explicit sentinel: when both agents send this exact marker as a full
// message, the team auto-disbands immediately — no idle wait, no minimum
// message count. Agents are instructed to use it in buildPromptPreview.
const EXPLICIT_DONE_SENTINEL = '<<COLLAB_DONE>>'

// Interactive gates that block agent startup and need an automated response.
// Debounced: same gate is not re-sent within 3 seconds to avoid key-repeat storms,
// and abandoned after MAX_GATE_ATTEMPTS so a permanently-matching screen can never
// starve the readiness check (a gate `continue`s past it).
//
// Codex's hook-review gate defaults to "continue without trusting" — ensemble spawns
// agents unattended, so it must not silently authorize hook code the user has not
// reviewed. Set ENSEMBLE_CODEX_TRUST_HOOKS=1 to answer "trust all" instead, or answer
// the prompt once by hand in a normal `codex` session to stop it recurring.
const MAX_GATE_ATTEMPTS = 5

interface AutoConfirmGate {
  name: string
  pattern: RegExp
  /** Keys sent in order when the gate is detected. */
  respond: Array<{ keys: string; opts?: { literal?: boolean; enter?: boolean } }>
}

const AUTO_CONFIRM_GATES: AutoConfirmGate[] = [
  {
    name: 'trust prompt',
    pattern: /Do you trust the contents of this directory\?|Quick safety check:|Yes, I trust this folder/i,
    respond: [{ keys: 'Enter' }],
  },
  {
    name: 'bypass permissions warning',
    pattern: /WARNING: Claude Code running in Bypass Permissions mode/i,
    respond: [{ keys: 'Down', opts: { enter: true } }],
  },
  {
    // Codex >= 0.147: "Hooks need review / N hooks are new or changed".
    // Its "›" selection cursor is why codex's readyMarker could never be "›".
    name: 'codex hooks review',
    pattern: /Hooks? needs? review|hooks? (?:are|is) new or changed/i,
    respond: [{
      keys: process.env.ENSEMBLE_CODEX_TRUST_HOOKS === '1' ? '2' : '3',
      opts: { literal: true },
    }],
  },
]

// ─── Collab bridge lifecycle ────────────────────────────────────────────────
//
// `ensemble bridge <teamId>` is the ONLY component that turns a `team-say`
// append into a *push* delivery: it tails messages.jsonl and POSTs every new
// line to /api/ensemble/teams/:id, which is what reaches sendTeamMessage() and
// therefore pasteFromFile into the recipient's PTY. Without a running bridge
// the bus degrades to pull-only and a silent agent is never woken — so the
// server owns the bridge's lifecycle: spawn on team creation, tree-kill on
// disband.
//
// The bridge is spawned detached (it must outlive an individual request) and
// therefore has to be tracked explicitly, in two places:
//   1. `bridgePids` — in-memory, marks pids THIS server process spawned, which
//      are trusted for killing without further checks.
//   2. `bridge.pid` in the team runtime dir — survives a server restart, but a
//      pid read back from it may be stale (the bridge died and Windows recycled
//      its pid onto an unrelated process), so it must be verified before any
//      kill. See `isBridgeProcess`.

const DEFAULT_BRIDGE_STOP_GRACE_MS = 1500
const BRIDGE_STOP_POLL_MS = 100

interface TrackedBridge {
  pid: number
  /** True when this server process spawned it — safe to kill without verifying. */
  owned: boolean
}

const bridgePids = new Map<string, TrackedBridge>()

/** Grace period a disbanding bridge gets to exit on its own .finished marker. */
function getBridgeStopGraceMs(): number {
  const raw = Number.parseInt(process.env.ENSEMBLE_BRIDGE_STOP_GRACE_MS || '', 10)
  return Number.isInteger(raw) && raw >= 0 ? raw : DEFAULT_BRIDGE_STOP_GRACE_MS
}

function readBridgePidFile(teamId: string): number {
  try {
    const pid = Number.parseInt(fs.readFileSync(collabBridgePid(teamId), 'utf-8').trim(), 10)
    return Number.isInteger(pid) && pid > 0 ? pid : 0
  } catch {
    return 0
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function clearBridgePidFile(teamId: string, pid: number): void {
  try {
    if (readBridgePidFile(teamId) === pid) fs.rmSync(collabBridgePid(teamId), { force: true })
  } catch { /* best effort */ }
}

function readProcessCommandLine(pid: number): Promise<string> {
  return new Promise(resolve => {
    execFile(
      'powershell.exe',
      [
        '-NoProfile', '-NonInteractive', '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
      ],
      { timeout: 5000, windowsHide: true },
      (error, stdout) => resolve(error ? '' : String(stdout).trim()),
    )
  })
}

/**
 * Prove a pid really is this team's bridge before killing it. Used for pids
 * recovered from bridge.pid after a server restart, where the original process
 * may be long gone and its pid recycled. The bridge is spawned as
 * `node --import tsx cli/ensemble.ts bridge <teamId>`, so both the literal
 * `bridge` verb and the team id appear in its command line.
 */
async function isBridgeProcess(pid: number, teamId: string): Promise<boolean> {
  const commandLine = await readProcessCommandLine(pid)
  if (!commandLine) return false
  return commandLine.includes(teamId) && /(^|[\s"'/\\])bridge(\s|$)/i.test(commandLine)
}

/**
 * Start the message bridge for a team. Never throws: a missing CLI entrypoint
 * or an EACCES on spawn degrades the team to pull-only delivery, which is far
 * better than failing team creation outright.
 */
export function startCollabBridge(teamId: string): number | undefined {
  try {
    ensureCollabDirs(teamId)
  } catch (err) {
    console.error(`[Ensemble] Cannot prepare runtime dir for bridge ${teamId}:`, err)
    return undefined
  }

  // Never double-spawn. Covers both a bridge we started earlier in this process
  // and one that survived a server restart; the CLI keeps its own pid-file
  // guard (cli/ensemble.ts) as a second line of defence.
  const existing = bridgePids.get(teamId)?.pid || readBridgePidFile(teamId)
  if (existing && isProcessAlive(existing)) {
    if (!bridgePids.has(teamId)) bridgePids.set(teamId, { pid: existing, owned: false })
    console.log(`[Ensemble] Collab bridge already running for ${teamId} (pid ${existing})`)
    return existing
  }

  try {
    const logFd = fs.openSync(collabBridgeLog(teamId), 'a')
    try {
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', path.join(REPO_ROOT, 'cli', 'ensemble.ts'), 'bridge', teamId],
        {
          cwd: REPO_ROOT,
          detached: true,
          windowsHide: true,
          stdio: ['ignore', logFd, logFd],
          env: { ...process.env, ENSEMBLE_ROOT: REPO_ROOT },
        },
      )

      child.on('error', (err: Error) => {
        console.error(`[Ensemble] Collab bridge for ${teamId} failed to start: ${err.message}`)
        if (child.pid && bridgePids.get(teamId)?.pid === child.pid) bridgePids.delete(teamId)
      })
      child.unref()

      if (!child.pid) {
        console.error(`[Ensemble] Collab bridge for ${teamId} produced no pid — push delivery degraded`)
        return undefined
      }

      bridgePids.set(teamId, { pid: child.pid, owned: true })
      // Write the pid ourselves instead of waiting for the bridge to do it, so a
      // disband racing bridge startup still has something to kill. The bridge
      // writes the same value moments later, and its own guard treats a pid file
      // holding its own pid as "not another instance".
      try {
        fs.writeFileSync(collabBridgePid(teamId), `${child.pid}\n`, 'utf8')
      } catch { /* the bridge writes it too */ }

      console.log(`[Ensemble] Collab bridge started for ${teamId} (pid ${child.pid})`)
      return child.pid
    } finally {
      // The fd is duplicated into the child at spawn time.
      try { fs.closeSync(logFd) } catch { /* already closed */ }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[Ensemble] Could not spawn collab bridge for ${teamId}: ${message}`)
    console.error('[Ensemble] Continuing without push delivery — team-read still works')
    return undefined
  }
}

/**
 * Stop a team's bridge. Callers should write the .finished marker first: the
 * bridge polls it every 500ms and shuts itself down cleanly after flushing, so
 * the tree-kill below is only the guarantee, not the normal path.
 */
export async function stopCollabBridge(teamId: string): Promise<void> {
  const tracked = bridgePids.get(teamId)
  const pid = tracked?.pid || readBridgePidFile(teamId)
  bridgePids.delete(teamId)
  if (!pid) return

  if (!isProcessAlive(pid)) {
    clearBridgePidFile(teamId, pid)
    return
  }

  const deadline = Date.now() + getBridgeStopGraceMs()
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, BRIDGE_STOP_POLL_MS))
    if (!isProcessAlive(pid)) {
      clearBridgePidFile(teamId, pid)
      return
    }
  }

  if (!tracked?.owned && !(await isBridgeProcess(pid, teamId))) {
    // Stale bridge.pid pointing at a recycled/unrelated pid — killing it would
    // take down someone else's process. Leave both the process and the file be;
    // a real bridge would exit on the .finished marker anyway.
    console.warn(`[Ensemble] bridge.pid ${pid} for ${teamId} is not a bridge process — not killing`)
    return
  }

  await killProcessTree(pid)
  clearBridgePidFile(teamId, pid)
  console.log(`[Ensemble] Collab bridge stopped for ${teamId} (pid ${pid})`)
}

/** Exit-handler safety net: detached bridges outlive the server unless killed. */
function stopAllCollabBridgesSync(): void {
  for (const [teamId, tracked] of bridgePids) {
    // Only pids this process spawned — a synchronous handler cannot verify the
    // rest, and the server is going down anyway.
    if (!tracked.owned || !isProcessAlive(tracked.pid)) continue
    killProcessTreeSync(tracked.pid)
    clearBridgePidFile(teamId, tracked.pid)
  }
  bridgePids.clear()
}

class EnsembleService {
  private readonly disbandingTeams = new Set<string>()
  private readonly idleCheckTimer: NodeJS.Timeout
  private readonly watchdog: AgentWatchdog

  constructor() {
    this.cleanupStaleTeams()
    this.idleCheckTimer = setInterval(() => {
      void this.checkIdleTeams()
    }, IDLE_CHECK_INTERVAL_MS)
    this.idleCheckTimer.unref()
    this.watchdog = new AgentWatchdog({
      loadTeams,
      getMessages: (teamId: string) => getMessages(teamId),
      appendMessage,
      getRuntime,
      resolveAgentProgram,
      collabDeliveryFile,
      markAgentStalled: (teamId: string, agentName: string, stalledAt: string) => {
        const team = getTeam(teamId)
        if (!team) return
        const agents = team.agents.map(agent =>
          agent.name === agentName ? { ...agent, stalledAt } : agent
        )
        updateTeam(teamId, { ...team, agents })
      },
    })

    for (const signal of ['SIGINT', 'SIGTERM', 'beforeExit', 'exit'] as const) {
      process.once(signal, () => this.stop())
    }
  }

  private cleanupStaleTeams(): void {
    const teams = loadTeams()
    const staleThresholdMs = 2 * 60 * 60 * 1000 // 2 hours
    const now = Date.now()
    let count = 0
    for (const team of teams) {
      if (team.status !== 'active') continue
      const age = now - new Date(team.createdAt).getTime()
      if (age > staleThresholdMs) {
        updateTeam(team.id, { ...team, status: 'disbanded' })
        // A bridge from a previous server run may still be tailing this team.
        void stopCollabBridge(team.id).catch(() => { /* best effort */ })
        count++
      }
    }
    if (count > 0) {
      console.log(`[Ensemble] Startup cleanup: disbanded ${count} stale active team(s)`)
    }
  }

  async checkIdleTeams(): Promise<void> {
    const teams = loadTeams().filter(team => team.status === 'active')

    for (const team of teams) {
      if (this.disbandingTeams.has(team.id)) continue
      const reason = this.autoDisbandReason(team)
      if (!reason) continue

      this.disbandingTeams.add(team.id)

      try {
        appendMessage(team.id, {
          id: randomUUID(),
          teamId: team.id,
          from: 'ensemble',
          to: 'team',
          content: `Auto-disband: ${reason}`,
          type: 'chat',
          timestamp: new Date().toISOString(),
        })

        await writeDisbandSummary(team.id)
        await disbandTeam(team.id)
      } catch (err) {
        console.error(`[Ensemble] Auto-disband failed for ${team.id}:`, err)
      } finally {
        this.disbandingTeams.delete(team.id)
      }
    }
  }

  /** Why this team should auto-disband right now, or null to leave it running. */
  private autoDisbandReason(team: EnsembleTeam): string | null {
    const messages = getMessages(team.id)
    const nonEnsembleMessages = messages.filter(message => message.from !== 'ensemble')
    const lastMessage = nonEnsembleMessages[nonEnsembleMessages.length - 1]
    if (!lastMessage) return null

    // Explicit sentinel path: if at least two DIFFERENT active agents have
    // sent the exact done sentinel, disband immediately. This bypasses the
    // min-message count and the idle wait — the agents have explicitly
    // agreed the task is done.
    const activeNames = new Set(team.agents.filter(a => a.status === 'active').map(a => a.name))
    const sentinelSenders = new Set(
      messages
        .filter(m => activeNames.has(m.from) && m.content.trim() === EXPLICIT_DONE_SENTINEL)
        .map(m => m.from),
    )
    if (sentinelSenders.size >= 2) {
      return `both agents sent ${EXPLICIT_DONE_SENTINEL}`
    }

    // Don't auto-disband until agents have exchanged enough messages
    if (nonEnsembleMessages.length < MIN_MESSAGES_BEFORE_AUTO_DISBAND) return null

    // Robust timestamp handling: skip idle check if no timestamp available
    const lastTimestamp = lastMessage.timestamp
      ? new Date(lastMessage.timestamp).getTime()
      : NaN
    if (Number.isNaN(lastTimestamp)) return null

    const activeAgents = team.agents.filter(agent => agent.status === 'active')
    if (activeAgents.length === 0) return null

    // Nothing said for a long time — the run is over in practice. Wording is
    // deliberately not consulted: phrases like "done" or "completed" appear
    // constantly in normal working chatter, and treating them as an end signal
    // used to kill teams seconds after a closing remark, mid-conversation.
    const idleForMs = Date.now() - lastTimestamp
    if (idleForMs < IDLE_DISBAND_MS) return null
    return `no agent message for ${formatDuration(idleForMs)}`
  }

  private stop(): void {
    clearInterval(this.idleCheckTimer)
    this.watchdog.stop()
    stopAllCollabBridgesSync()
  }
}

const ensembleService = new EnsembleService()

function formatDuration(durationMs: number): string {
  const durationMin = Math.max(0, Math.round(durationMs / 60000))
  return durationMin >= 60
    ? `${Math.floor(durationMin / 60)}h ${durationMin % 60}m`
    : `${durationMin}m`
}

export function loadCollabTemplate(templateName?: string): CollabTemplatesFile['templates'][string] | undefined {
  if (!templateName) return undefined
  try {
    const templatesPath = path.join(__dirname, '..', 'collab-templates.json')
    const raw = fs.readFileSync(templatesPath, 'utf-8')
    const data: CollabTemplatesFile = JSON.parse(raw)
    const template = data.templates[templateName]
    if (!template) {
      console.warn(`[Ensemble] Unknown template "${templateName}", falling back to default roles`)
      return undefined
    }
    console.log(`[Ensemble] Loaded template "${templateName}" (${template.name})`)
    return template
  } catch (err) {
    console.warn(`[Ensemble] Failed to load templates:`, err)
    return undefined
  }
}

export function buildPromptPreview(params: {
  teamId: string
  teamName: string
  description: string
  agentName: string
  teammateNames: string[]
  agentIndex: number
  templateName?: string
}): string {
  const template = loadCollabTemplate(params.templateName)
  const cli = `node "${path.join(REPO_ROOT, 'bin', 'ensemble.cjs')}"`
  const teamSayCmd = `${cli} team-say ${params.teamId} ${params.agentName} ${params.teammateNames[0] || 'team'}`
  const teamReadCmd = `${cli} team-read ${params.teamId}`

  let roleInstructions: string[]

  if (template && params.agentIndex < template.roles.length) {
    const templateRole = template.roles[params.agentIndex]
    roleInstructions = [
      `ROLE: ${templateRole.role}.`,
      templateRole.focus,
    ]
  } else {
    const isLead = params.agentIndex === 0
    const roleName = isLead ? 'LEAD' : 'WORKER'
    roleInstructions = isLead
      ? [
          `ROLE: ${roleName}.`,
          `You own architecture, planning, high-level design, task breakdown, and code review.`,
          `Your first action after greeting is to share a concrete implementation plan with the worker before any implementation starts.`,
          `Keep the worker focused by delegating clear implementation steps, reviewing progress, and calling out risks or design corrections early.`,
        ]
      : [
          `ROLE: ${roleName}.`,
          `You own implementation, writing code, running tests, and reporting concrete execution progress.`,
          `After greeting, wait for the lead's plan before starting implementation work.`,
          `Once the lead shares a plan, execute it pragmatically, report what you changed, and surface blockers or test failures quickly.`,
        ]
  }

  return [
    `You are ${params.agentName} in team "${params.teamName}" with teammate ${params.teammateNames.join(', ')}.`,
    `Task: ${params.description}`,
    ...roleInstructions,
    `COMMUNICATION RULES:`,
    `1. Send findings: ${teamSayCmd} "your message"`,
    `2. Read teammate messages: ${teamReadCmd}`,
    `3. After EVERY analysis step, run team-say to share what you found`,
    `4. After EVERY team-say, run team-read to check for responses`,
    `5. If teammate shared findings, RESPOND to them`,
    `6. Keep alternating: analyze, share, read, respond, analyze`,
    `DONE PROTOCOL (important):`,
    `7. When you believe the task is fully converged and there is nothing substantive left to say, explicitly propose closure to your teammate in a normal team-say message ("I think we're done because X — agree?").`,
    `8. Only once your teammate has confirmed agreement, send a FINAL team-say whose message is EXACTLY the sentinel <<COLLAB_DONE>> (nothing else, no quotes, no prose). As soon as both teammates have sent <<COLLAB_DONE>>, the system auto-disbands the team and writes the summary — so do not send it prematurely.`,
    `9. Before sending <<COLLAB_DONE>>, make sure the important conclusions (recommendation, rationale, build list, layout, decisions) are actually present as long team-say messages in the transcript — that is what the summary will preserve. Do not keep insights only in your head.`,
    `Start NOW: greet your teammate with team-say, then begin.`,
  ].join(' ')
}

export async function createEnsembleTeam(
  request: CreateTeamRequest
): Promise<ServiceResult<{ team: EnsembleTeam }>> {
  const team = createTeam(request)
  const cwd = request.workingDirectory || process.cwd()
  const worktreeMap = new Map<string, WorktreeInfo>()

  // Phase 0: Create worktrees if requested
  if (request.useWorktrees) {
    for (let i = 0; i < team.agents.length; i++) {
      const agentSpec = team.agents[i]
      try {
        const worktreeInfo = await createWorktree(team.id, agentSpec.name, cwd)
        worktreeMap.set(agentSpec.name, worktreeInfo)
        team.agents[i].worktreePath = worktreeInfo.path
        team.agents[i].worktreeBranch = worktreeInfo.branch
        appendMessage(team.id, {
          id: randomUUID(), teamId: team.id, from: 'ensemble', to: 'team',
          content: `🌳 Worktree created for ${agentSpec.name}: ${worktreeInfo.branch}`,
          type: 'chat', timestamp: new Date().toISOString(),
        })
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        console.error(`[Ensemble] Failed to create worktree for ${agentSpec.name}:`, message)
        appendMessage(team.id, {
          id: randomUUID(), teamId: team.id, from: 'ensemble', to: 'team',
          content: `⚠️ Worktree creation failed for ${agentSpec.name}: ${message}. Using shared directory.`,
          type: 'chat', timestamp: new Date().toISOString(),
        })
      }
    }
  }

  const buildPrompt = (agentName: string, otherNames: string[], agentIndex: number) => {
    return buildPromptPreview({
      teamId: team.id,
      teamName: team.name,
      description: team.description,
      agentName,
      teammateNames: otherNames,
      agentIndex,
      templateName: request.templateName,
    })
  }

  // Phase 1: Spawn all agents
  for (let i = 0; i < team.agents.length; i++) {
    const agentSpec = team.agents[i]
    const agentName = `${team.name}-${agentSpec.name}`
    const prompt = buildPrompt(agentSpec.name, team.agents.filter((_, j) => j !== i).map(a => a.name), i)

    ensureCollabDirs(team.id)
    const promptFile = collabPromptFile(team.id, agentSpec.name)
    fs.writeFileSync(promptFile, prompt)
    console.log(`[Ensemble] Prompt for ${agentSpec.name}: ${prompt}`)

    try {
      console.log(`[Ensemble] Spawning ${agentName} (${agentSpec.program})`)

      const agentCwd = worktreeMap.get(agentSpec.name)?.path || cwd
      const spawned = await spawnLocalAgent({
        name: agentName,
        program: agentSpec.program,
        workingDirectory: agentCwd,
      })

      team.agents[i].agentId = spawned.id
      team.agents[i].status = 'active'

      appendMessage(team.id, {
        id: randomUUID(), teamId: team.id, from: 'ensemble', to: 'team',
        content: `${agentSpec.name} (${agentSpec.program}) has joined #${team.name}`,
        type: 'chat', timestamp: new Date().toISOString(),
      })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[Ensemble] Failed to spawn ${agentName}:`, message)
      team.agents[i].status = 'idle'
      appendMessage(team.id, {
        id: randomUUID(), teamId: team.id, from: 'ensemble', to: 'team',
        content: `Failed to spawn ${agentName}: ${message}`,
        type: 'chat', timestamp: new Date().toISOString(),
      })
    }
  }

  updateTeam(team.id, { ...team, status: 'active' })

  // Start the message bridge before any prompt is injected: it is the only
  // path from a `team-say` append to a push delivery into a teammate's PTY.
  // Failure here is non-fatal — the team stays usable via `team-read`.
  startCollabBridge(team.id)

  // Phase 2: Wait for ALL agents to be ready, then inject prompts
  const activeAgents = team.agents.filter(a => a.status === 'active')
  if (activeAgents.length >= 2) {
    const runtime = getRuntime()

    // A team can be disbanded (API, auto-disband) while startup is
    // still waiting on readiness. Without this, startup marches on and reports
    // confusing "PTY session not found" failures for sessions it killed itself.
    const teamWasDisbanded = (): boolean => {
      if (fs.existsSync(collabFinishedMarker(team.id))) return true
      const current = getTeam(team.id)
      return !current || current.status === 'disbanded'
    }

    const sessionHasExited = async (sessionName: string): Promise<boolean> => {
      try {
        return (await runtime.sessionExists(sessionName)) === false
      } catch {
        return false
      }
    }

    const waitForReady = async (
      sessionName: string, program: string, maxWait = READY_TIMEOUT_MS,
    ): Promise<boolean> => {
      const start = Date.now()
      const readyMarkers = resolveReadyMarkers(program)
      const gateAttempts = new Map<string, number>()
      let lastGateName = ''
      let lastGateHandledAt = 0
      let lastError = ''
      let lastPane = ''
      let lastPaneChangedAt = start
      while (Date.now() - start < maxWait) {
        if (teamWasDisbanded()) {
          console.log(`[Ensemble] ${sessionName} readiness wait aborted — team ${team.id} was disbanded`)
          return false
        }
        // A session that has exited is never going to become ready. Report that
        // distinctly instead of burning the whole window and blaming a timeout.
        // An unusable sessionExists is treated as "unknown" — keep waiting.
        if (await sessionHasExited(sessionName)) {
          console.error(`[Ensemble] ${sessionName} exited before becoming ready (${Math.round((Date.now() - start) / 1000)}s)`)
          return false
        }
        try {
          const output = await runtime.capturePane(sessionName, 50)
          const gate = AUTO_CONFIRM_GATES.find(candidate =>
            candidate.pattern.test(output) && (gateAttempts.get(candidate.name) ?? 0) < MAX_GATE_ATTEMPTS
          )
          if (gate) {
            const now = Date.now()
            if (gate.name !== lastGateName || now - lastGateHandledAt >= 3000) {
              for (const key of gate.respond) {
                await runtime.sendKeys(sessionName, key.keys, key.opts)
              }
              const attempts = (gateAttempts.get(gate.name) ?? 0) + 1
              gateAttempts.set(gate.name, attempts)
              lastGateName = gate.name
              lastGateHandledAt = now
              console.log(`[Ensemble] Auto-confirmed ${gate.name} in ${sessionName} (attempt ${attempts}/${MAX_GATE_ATTEMPTS})`)
              if (attempts >= MAX_GATE_ATTEMPTS) {
                console.warn(`[Ensemble] ${gate.name} did not clear in ${sessionName}; ignoring it and checking readiness directly`)
              }
            }
            await new Promise(r => setTimeout(r, 1000))
            continue
          }
          const marker = matchReadyMarker(output, readyMarkers)
          if (marker) {
            console.log(
              `[Ensemble] ${sessionName} is ready (${Math.round((Date.now() - start) / 1000)}s,`
              + ` matched ${JSON.stringify(marker)})`
            )
            return true
          }

          // Fallback: no marker matched, but the CLI has painted a screen that
          // has since stopped changing. A working agent redraws constantly
          // while it starts up (spinners, progress, hook output), so a screen
          // that is byte-identical for QUIESCENT_READY_MS is an agent sitting
          // at its prompt behind a marker we don't recognise. Without this a
          // single UI tweak upstream costs the whole READY_TIMEOUT_MS window.
          if (output !== lastPane) {
            lastPane = output
            lastPaneChangedAt = Date.now()
          } else if (isQuiescentReady(output, Date.now() - lastPaneChangedAt, QUIESCENT_READY_MS)) {
            console.warn(
              `[Ensemble] ${sessionName} assumed ready (${Math.round((Date.now() - start) / 1000)}s):`
              + ` no marker in ${JSON.stringify(readyMarkers)}, but the screen has been idle`
              + ` for ${QUIESCENT_READY_MS / 1000}s`
            )
            return true
          }
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err)
        }
        await new Promise(r => setTimeout(r, 1000))
      }
      console.error(
        `[Ensemble] ${sessionName} did not become ready within ${maxWait / 1000}s`
        + ` (looking for ${JSON.stringify(readyMarkers)})`
        + (lastError ? ` — last error: ${lastError}` : '')
      )
      // Without this the timeout is undiagnosable after the fact: the session is
      // killed on disband and its screen goes with it. Log what the agent was
      // actually showing so the next occurrence explains itself.
      const tail = lastPane.split('\n').map(line => line.trimEnd()).filter(line => line.trim()).slice(-12)
      console.error(
        `[Ensemble] ${sessionName} last screen (${tail.length} lines):\n`
        + (tail.length ? tail.join('\n') : '(nothing — the session produced no output)')
      )
      return false
    }

    console.log(`[Ensemble] Waiting for all ${activeAgents.length} agents to be ready...`)
    const readyResults = await Promise.all(
      activeAgents.map(agent => {
        const sessionName = `${team.name}-${agent.name}`
        return waitForReady(sessionName, agent.program).then(ready => ({ agent, sessionName, ready }))
      })
    )

    if (teamWasDisbanded()) {
      console.log(`[Ensemble] Team ${team.id} was disbanded during startup — skipping prompt injection`)
      return { data: { team }, status: 201 }
    }

    const ready = readyResults.filter(r => r.ready)
    const notReady = readyResults.filter(r => !r.ready)

    // Best-effort readiness — Codex CLI in particular often misses the readyMarker
    // while being functionally ready. Don't abort; warn and proceed with prompt
    // injection for ALL agents whose terminal session exists. Their CLI will buffer
    // the paste and process it when they reach the input prompt.
    for (const nr of notReady) {
      console.warn(`[Ensemble] ${nr.sessionName} did not signal ready in time — attempting prompt injection anyway`)
      appendMessage(team.id, {
        id: randomUUID(), teamId: team.id, from: 'ensemble', to: 'team',
        content: `⚠ ${nr.agent.name} did not signal ready in time — injecting prompt anyway (best-effort)`,
        type: 'chat', timestamp: new Date().toISOString(),
      })
    }

    // Inject into every agent whose session is still alive — "not ready" is only
    // best-effort evidence, but a dead session is definitive: pasting into it just
    // raises "PTY session not found" and buries the real cause.
    const liveness = await Promise.all(readyResults.map(async result => ({
      result,
      alive: !(await sessionHasExited(result.sessionName)),
    })))
    for (const { result } of liveness.filter(entry => !entry.alive)) {
      console.error(`[Ensemble] ${result.sessionName} has no live session — skipping prompt injection`)
      appendMessage(team.id, {
        id: randomUUID(), teamId: team.id, from: 'ensemble', to: 'team',
        content: `❌ ${result.agent.name} exited before it could be prompted — its CLI never reached an input prompt`,
        type: 'chat', timestamp: new Date().toISOString(),
      })
    }
    const injectTargets = liveness.filter(entry => entry.alive).map(entry => entry.result)
    if (injectTargets.length === 0) {
      appendMessage(team.id, {
        id: randomUUID(), teamId: team.id, from: 'ensemble', to: 'team',
        content: `❌ Team start aborted: no agents available for prompt injection`,
        type: 'chat', timestamp: new Date().toISOString(),
      })
      return { data: { team }, status: 201 }
    }
    if (notReady.length > 0) {
      // Give the non-ready agents a small extra grace window before pasting,
      // so any in-progress trust prompts or async init can complete.
      await new Promise(r => setTimeout(r, 3000))
    }

    await new Promise(r => setTimeout(r, 2000))

    // Phase 3: Inject prompts (skip if staged — staged workflow handles its own prompts)
    if (request.staged) {
      // Staged mode: skip normal prompt injection, run plan→exec→verify workflow
      appendMessage(team.id, {
        id: randomUUID(), teamId: team.id, from: 'ensemble', to: 'team',
        content: `🚀 ${injectTargets.length}/${activeAgents.length} agents — starting staged workflow (plan → exec → verify)`,
        type: 'chat', timestamp: new Date().toISOString(),
      })

      const buildStagedPlanPrompt = (agentName: string, otherNames: string[], agentIndex: number): string => [
        buildPrompt(agentName, otherNames, agentIndex),
        `STAGED WORKFLOW MODE.`,
        `PHASE 1 PLAN: ONLY create and share a plan via team-say.`,
        `Do NOT write code, edit files, or run mutating commands yet.`,
        `Both agents must share their plan before implementation begins.`,
        `After sharing your plan, run team-read and align on the execution approach.`,
      ].join(' ')

      const buildStagedExecPrompt = (otherNames: string[]): string => [
        `PHASE 2 EXEC: Planning is complete.`,
        `You may now execute the agreed plan and make code changes.`,
        `Share concrete progress via team-say and explicitly report when your implementation is done.`,
        `Keep coordinating with ${otherNames.join(', ')} as you work.`,
      ].join(' ')

      const buildStagedVerifyPrompt = (teammateToReview?: string): string => [
        `PHASE 3 VERIFY: Review ${teammateToReview || 'your teammate'}'s work.`,
        `Inspect what they changed, compare it against the plan, and report findings via team-say.`,
        `Focus on bugs, regressions, missing tests, and mismatches with the agreed approach.`,
      ].join(' ')

      // Run in background so createEnsembleTeam returns immediately
      runStagedWorkflow(team, request.stagedConfig, {
        buildPlanPrompt: ({ agent, teammates, index }) => buildStagedPlanPrompt(agent.name, teammates, index),
        buildExecPrompt: ({ teammates }) => buildStagedExecPrompt(teammates),
        buildVerifyPrompt: ({ teammateToReview }) => buildStagedVerifyPrompt(teammateToReview),
      }).catch(err => {
        const message = err instanceof Error ? err.message : String(err)
        console.error(`[Ensemble] Staged workflow failed for ${team.id}:`, message)
        appendMessage(team.id, {
          id: randomUUID(), teamId: team.id, from: 'ensemble', to: 'team',
          content: `❌ Staged workflow failed: ${message}`,
          type: 'chat', timestamp: new Date().toISOString(),
        })
      })
    } else {
      // Normal mode: inject prompts simultaneously
      console.log(`[Ensemble] Injecting prompts into ${injectTargets.length} agents (${ready.length} ready, ${notReady.length} best-effort)`)
      await Promise.all(
        injectTargets.map(async ({ agent, sessionName }) => {
          const promptFile = collabPromptFile(team.id, agent.name)
          try {
            const agentCfg = resolveAgentProgram(agent.program)
            if (agentCfg.inputMethod === 'pasteFromFile') {
              await runtime.pasteFromFile(sessionName, promptFile)
            } else {
              const prompt = fs.readFileSync(promptFile, 'utf-8')
              await runtime.sendKeys(sessionName, prompt, { literal: true, enter: true })
            }
            await ensureSubmitted(runtime, sessionName)
            console.log(`[Ensemble] ✓ Prompt injected into ${sessionName}`)
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            appendMessage(team.id, {
              id: randomUUID(), teamId: team.id, from: 'ensemble', to: 'team',
              content: `❌ Delivery to ${agent.name} failed: ${message}`,
              type: 'chat', timestamp: new Date().toISOString(),
            })
            console.error(`[Ensemble] ✗ Failed to inject prompt into ${sessionName}:`, err)
          }
        })
      )

      appendMessage(team.id, {
        id: randomUUID(), teamId: team.id, from: 'ensemble', to: 'team',
        content: `🚀 ${injectTargets.length} agents received their task — collaboration started${notReady.length ? ` (${notReady.length} via best-effort fallback)` : ''}`,
        type: 'chat', timestamp: new Date().toISOString(),
      })
    }
  }

  return { data: { team }, status: 201 }
}

export function getEnsembleTeam(teamId: string): ServiceResult<{ team: EnsembleTeam; messages: EnsembleMessage[] }> {
  const team = getTeam(teamId)
  if (!team) return { error: 'Team not found', status: 404 }
  return { data: { team, messages: getMessages(teamId) }, status: 200 }
}

export function listEnsembleTeams(): ServiceResult<{ teams: EnsembleTeam[] }> {
  return { data: { teams: loadTeams() }, status: 200 }
}

export async function checkIdleTeams(): Promise<void> {
  await ensembleService.checkIdleTeams()
}

export function getTeamFeed(teamId: string, since?: string): ServiceResult<{ messages: EnsembleMessage[] }> {
  const team = getTeam(teamId)
  if (!team) return { error: 'Team not found', status: 404 }
  return { data: { messages: getMessages(teamId, since) }, status: 200 }
}

export async function sendTeamMessage(
  teamId: string, to: string, content: string, from?: string,
  existingId?: string, existingTimestamp?: string,
): Promise<ServiceResult<{ message: EnsembleMessage }>> {
  const team = getTeam(teamId)
  if (!team) return { error: 'Team not found', status: 404 }

  const message: EnsembleMessage = {
    id: existingId || randomUUID(), teamId, from: from || 'user', to, content,
    type: 'chat', timestamp: existingTimestamp || new Date().toISOString(),
  }
  appendMessage(teamId, message)

  // Determine which agents should receive this message in their terminal
  const sender = from || 'user'
  const recipients = to === 'team'
    ? team.agents.filter(a => a.status === 'active' && a.name !== sender)
    : team.agents.filter(a => a.status === 'active' && a.name === to)

  const runtime = getRuntime()

  for (const targetAgent of recipients) {
    try {
      const sessionName = `${team.name}-${targetAgent.name}`

      // Skip delivery if the agent's terminal session no longer exists (agent finished and exited)
      const paneAlive = await runtime.sessionExists(sessionName)
      if (!paneAlive) continue

      // Wrap message with sender context + response nudge
      const deliveryText = [
        `[Team message from ${sender}]: ${content}`,
        `→ Respond with team-say. Then run team-read to check for more messages.`,
      ].join('\n')

      // Always use pasteFromFile for message delivery to avoid shell escaping
      // issues (typed input breaks on ?, !, `, $ and \ in PowerShell)
      const tmpFile = collabDeliveryFile(teamId, sessionName)
      fs.mkdirSync(path.dirname(tmpFile), { recursive: true })
      fs.writeFileSync(tmpFile, deliveryText)
      await runtime.pasteFromFile(sessionName, tmpFile)
      await ensureSubmitted(runtime, sessionName)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      appendMessage(teamId, {
        id: randomUUID(), teamId, from: 'ensemble', to: 'team',
        content: `❌ Delivery to ${targetAgent.name} failed: ${reason}`,
        type: 'chat', timestamp: new Date().toISOString(),
      })
    }
  }

  return { data: { message }, status: 200 }
}

/**
 * Write a summary file for a disbanded team — used by auto-disband and can be
 * picked up by the background watcher in the Claude Code session.
 * Writes the human-readable summary.txt for a disbanded team.
 */
export async function writeDisbandSummary(teamId: string): Promise<void> {
  const team = getTeam(teamId)
  if (!team) return

  const messages = getMessages(teamId)
  const agentMsgs = messages.filter(m => m.from !== 'ensemble' && m.from !== 'user')
  if (agentMsgs.length === 0) return

  const now = new Date()
  const createdAt = new Date(team.createdAt)
  const durationMs = now.getTime() - createdAt.getTime()
  const duration = formatDuration(durationMs)

  const agents = [...new Set(agentMsgs.map(m => m.from))]

  // Scrape token usage from each agent's terminal (best-effort)
  const tokenUsageMap: Record<string, string> = {}
  await Promise.all(
    team.agents
      .filter(a => a.status === 'active')
      .map(async (agent) => {
        const sessionName = `${team.name}-${agent.name}`
        tokenUsageMap[agent.name] = await getAgentTokenUsage(sessionName)
      })
  )

  const cleanContent = (s: string) => scrubCollabRuntimePaths(s).trim()

  const summaryText = agents.map(agent => {
    const msgs = agentMsgs
      .filter(m => m.from === agent)
      .map(m => ({ ...m, content: cleanContent(m.content) }))
      .filter(m => m.content && m.content !== EXPLICIT_DONE_SENTINEL)
    const tokens = tokenUsageMap[agent] || 'unknown'
    // Pick the top 3 longest substantive messages — these almost always
    // contain the recommendation, rationale, build list, or concrete
    // conclusions that matter. Fall back to first/last if <3 total.
    const ranked = [...msgs].sort((a, b) => b.content.length - a.content.length).slice(0, 3)
    const keyMsgs = ranked.length
      ? ranked
          .map((m, i) => `  [${i + 1}] (${m.content.length} chars)\n    ${m.content.slice(0, 1200).replace(/\n/g, '\n    ')}`)
          .join('\n')
      : '  (no substantive messages)'
    return `${agent} (${msgs.length} msgs, tokens: ${tokens})\nKey messages:\n${keyMsgs}`
  }).join('\n\n')

  const summaryFile = collabSummaryFile(teamId)
  const transcriptPointer = getFeedFile(teamId)
  fs.mkdirSync(path.dirname(summaryFile), { recursive: true })
  fs.writeFileSync(
    summaryFile,
    `Task: ${team.description || 'unknown'}\nDuration: ${duration}\nMessages: ${agentMsgs.length}\nFull transcript: ${transcriptPointer}\n\n${summaryText}`,
  )
  console.log(`[Ensemble] Summary written to ${summaryFile}`)
}

export async function disbandTeam(teamId: string): Promise<ServiceResult<{ team: EnsembleTeam }>> {
  const team = getTeam(teamId)
  if (!team) return { error: 'Team not found', status: 404 }

  // Write summary before killing sessions so the Claude Code session can present it
  await writeDisbandSummary(teamId)

  for (const agent of team.agents) {
    if (agent.status === 'active') {
      appendMessage(teamId, {
        id: randomUUID(), teamId, from: 'ensemble', to: 'team',
        content: `${agent.name} has left #${team.name}`,
        type: 'chat', timestamp: new Date().toISOString(),
      })

      try {
        await killLocalAgent(`${team.name}-${agent.name}`)
      } catch { /* session may already be gone */ }
    }
  }

  const agentsWithWorktrees = team.agents.filter(
    a => a.worktreePath && a.worktreeBranch
  )
  if (agentsWithWorktrees.length > 0) {
    await new Promise(resolve => setTimeout(resolve, 2000))

    const firstWorktree = agentsWithWorktrees[0].worktreePath!
    const worktreesDir = path.dirname(firstWorktree)
    const basePath = path.dirname(worktreesDir)

    for (const agent of agentsWithWorktrees) {
      const worktreeInfo: WorktreeInfo = {
        path: agent.worktreePath!,
        branch: agent.worktreeBranch!,
        agentName: agent.name,
      }
      const result = await mergeWorktree(worktreeInfo, basePath)

      appendMessage(teamId, {
        id: randomUUID(), teamId, from: 'ensemble', to: 'team',
        content: result.success
          ? `🌳 Merged ${agent.name}'s worktree (${agent.worktreeBranch})`
          : `⚠️ Merge conflict for ${agent.name}: ${result.conflicts?.join(', ')}`,
        type: 'chat', timestamp: new Date().toISOString(),
      })
    }

    for (const agent of agentsWithWorktrees) {
      const worktreeInfo: WorktreeInfo = {
        path: agent.worktreePath!,
        branch: agent.worktreeBranch!,
        agentName: agent.name,
      }
      await destroyWorktree(worktreeInfo, basePath)
    }
  }

  const updated = updateTeam(teamId, {
    status: 'disbanded',
    completedAt: new Date().toISOString(),
  })

  // Signal the bridge to stop *before* touching its bookkeeping files: it polls
  // the .finished marker and exits cleanly on it, flushing anything queued.
  try {
    fs.mkdirSync(collabRuntimeDir(teamId), { recursive: true })
    fs.writeFileSync(collabFinishedMarker(teamId), new Date().toISOString())
  } catch { /* non-fatal cleanup */ }
  await stopCollabBridge(teamId)

  // Soft cleanup: remove ephemeral files, keep messages/summary/log
  try {
    const deliveryDir = path.join(collabRuntimeDir(teamId), 'delivery')
    if (fs.existsSync(deliveryDir)) fs.rmSync(deliveryDir, { recursive: true, force: true })
    for (const f of [collabBridgeResult(teamId), collabBridgePosted(teamId)]) {
      if (fs.existsSync(f)) fs.unlinkSync(f)
    }
  } catch { /* non-fatal cleanup */ }

  return { data: { team: updated! }, status: 200 }
}
