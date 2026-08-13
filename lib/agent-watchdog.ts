import fs from 'fs'
import path from 'path'
import { v4 as uuidv4 } from 'uuid'
import type { AgentRuntime } from './agent-runtime'
import { ensureSubmitted } from './paste-submit'
import type { EnsembleMessage, EnsembleTeam } from '../types/ensemble'

const DEFAULT_POLL_INTERVAL_MS = 30_000
const DEFAULT_NUDGE_MS = 90_000
const DEFAULT_STALL_MS = 180_000
const WATCHDOG_NUDGE_TEXT = 'Are you still working? Share your progress with team-say.'

interface AgentWatchdogState {
  lastMessageAt: string
  nudgedAt?: string
  stalledAt?: string
}

interface AgentWatchdogDeps {
  loadTeams: () => EnsembleTeam[]
  getMessages: (teamId: string) => EnsembleMessage[]
  appendMessage: (teamId: string, message: EnsembleMessage) => void
  getRuntime: () => Pick<AgentRuntime, 'sendKeys' | 'pasteFromFile' | 'sessionExists' | 'capturePane'>
  resolveAgentProgram: (program: string) => { inputMethod: 'pasteFromFile' | 'sendKeys' }
  /** Records the stall where API consumers can see it. Optional for tests. */
  markAgentStalled?: (teamId: string, agentName: string, stalledAt: string) => void
  isSelf: (hostId?: string) => boolean
  getHostById: (hostId: string) => { url: string } | undefined
  postRemoteSessionCommand: (url: string, sessionName: string, text: string) => Promise<void>
  collabDeliveryFile: (teamId: string, sessionName: string) => string
  now?: () => number
  nudgeAfterMs?: number
  stallAfterMs?: number
  pollIntervalMs?: number
}

function parseDuration(rawValue: string | undefined, fallback: number): number {
  const parsed = Number(rawValue)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export function getWatchdogNudgeMs(): number {
  return parseDuration(process.env.ENSEMBLE_WATCHDOG_NUDGE_MS, DEFAULT_NUDGE_MS)
}

export function getWatchdogStallMs(): number {
  return parseDuration(process.env.ENSEMBLE_WATCHDOG_STALL_MS, DEFAULT_STALL_MS)
}

export class AgentWatchdog {
  private readonly state = new Map<string, AgentWatchdogState>()
  private readonly timer: NodeJS.Timeout
  private readonly now: () => number
  private readonly nudgeAfterMs: number
  private readonly stallAfterMs: number

  constructor(private readonly deps: AgentWatchdogDeps) {
    this.now = deps.now ?? Date.now
    this.nudgeAfterMs = deps.nudgeAfterMs ?? getWatchdogNudgeMs()
    this.stallAfterMs = deps.stallAfterMs ?? getWatchdogStallMs()

    this.timer = setInterval(() => {
      void this.poll()
    }, deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS)
    this.timer.unref()
  }

  async poll(): Promise<void> {
    const activeTeams = this.deps.loadTeams().filter(team => team.status === 'active')
    const activeTeamIds = new Set(activeTeams.map(team => team.id))

    for (const key of this.state.keys()) {
      const teamId = key.split(':', 1)[0]
      if (!activeTeamIds.has(teamId)) this.state.delete(key)
    }

    for (const team of activeTeams) {
      await this.pollTeam(team)
    }
  }

  stop(): void {
    clearInterval(this.timer)
    this.state.clear()
  }

  private async pollTeam(team: EnsembleTeam): Promise<void> {
    const messages = this.deps.getMessages(team.id)
    const activeAgents = team.agents.filter(candidate => candidate.status === 'active')
    const activeAgentNames = new Set(activeAgents.map(agent => agent.name))

    for (const key of this.state.keys()) {
      if (!key.startsWith(`${team.id}:`)) continue
      const agentName = key.slice(team.id.length + 1)
      if (!activeAgentNames.has(agentName)) this.state.delete(key)
    }

    for (const agent of activeAgents) {
      const stateKey = `${team.id}:${agent.name}`
      const lastAgentMessage = [...messages].reverse().find(message => message.from === agent.name)
      const lastMessageAt = lastAgentMessage?.timestamp || team.createdAt
      const previousState = this.state.get(stateKey)

      if (!previousState) {
        this.state.set(stateKey, { lastMessageAt })
      } else if (previousState.lastMessageAt !== lastMessageAt) {
        this.state.set(stateKey, { lastMessageAt })
        continue
      }

      const lastMessageMs = new Date(lastMessageAt).getTime()
      if (Number.isNaN(lastMessageMs)) continue

      const nowMs = this.now()
      const idleMs = nowMs - lastMessageMs
      const currentState = this.state.get(stateKey) ?? { lastMessageAt }

      if (!currentState.nudgedAt && idleMs >= this.nudgeAfterMs) {
        try {
          await this.nudgeAgent(team, agent.name, agent.program, agent.hostId)
          this.state.set(stateKey, {
            lastMessageAt,
            nudgedAt: new Date(nowMs).toISOString(),
          })
        } catch (err) {
          await this.handleNudgeFailure(team, agent.name, agent.hostId, stateKey, lastMessageAt, nowMs, err)
        }
        continue
      }

      if (!currentState.nudgedAt || currentState.stalledAt) continue

      const nudgedMs = new Date(currentState.nudgedAt).getTime()
      if (Number.isNaN(nudgedMs) || nowMs - nudgedMs < this.stallAfterMs) continue

      console.warn(`[Watchdog] Agent ${agent.name} in team ${team.id} stalled after watchdog nudge`)
      this.deps.appendMessage(team.id, {
        id: uuidv4(),
        teamId: team.id,
        from: 'ensemble',
        to: 'team',
        content: `⚠️ Watchdog marked ${agent.name} as stalled after ${Math.round((nowMs - nudgedMs) / 1000)}s without progress after nudge`,
        type: 'chat',
        timestamp: new Date(nowMs).toISOString(),
      })
      const stalledAt = new Date(nowMs).toISOString()
      this.state.set(stateKey, { ...currentState, stalledAt })
      // Without this the stall existed only in this in-memory map, so every API
      // consumer kept reporting a dead agent as healthy.
      try {
        this.deps.markAgentStalled?.(team.id, agent.name, stalledAt)
      } catch (err) {
        console.error(`[Watchdog] Could not record stall for ${agent.name}:`, err)
      }
    }
  }

  private async nudgeAgent(team: EnsembleTeam, agentName: string, _program: string, hostId?: string): Promise<void> {
    const sessionName = `${team.name}-${agentName}`
    if (hostId && !this.deps.isSelf(hostId)) {
      const host = this.deps.getHostById(hostId)
      if (host) {
        await this.deps.postRemoteSessionCommand(host.url, sessionName, WATCHDOG_NUDGE_TEXT)
      }
    } else {
      // Always use pasteFromFile to avoid shell escaping issues with sendKeys
      const runtime = this.deps.getRuntime()
      const filePath = this.deps.collabDeliveryFile(team.id, sessionName)
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, WATCHDOG_NUDGE_TEXT)
      await runtime.pasteFromFile(sessionName, filePath)
      // A pasted nudge parks in the composer just like any other paste.
      await ensureSubmitted(runtime, sessionName)
    }

    // Only report the nudge as having happened once it actually succeeded —
    // appending this before the send (as before) left a false "nudged" message
    // in the team feed on every failed attempt, on top of the failure message.
    this.deps.appendMessage(team.id, {
      id: uuidv4(),
      teamId: team.id,
      from: 'ensemble',
      to: 'team',
      content: `👀 Watchdog nudged ${agentName}: ${WATCHDOG_NUDGE_TEXT}`,
      type: 'chat',
      timestamp: new Date(this.now()).toISOString(),
    })
  }

  /**
   * Handle a failed nudge attempt. A missing/gone PTY session is terminal for
   * that agent — retrying it every poll tick can never succeed, so we mark it
   * stalled immediately and emit exactly one notification. Any other error is
   * treated as transient: we still record `nudgedAt` so the next 30s tick
   * can't immediately re-fire the same failing nudge (that was the bug — the
   * catch path previously left `nudgedAt` unset, so every tick re-attempted
   * the nudge and re-appended a "failed to nudge" message forever). Setting
   * `nudgedAt` here hands control to the existing stall-after-nudge check
   * below, which will mark the agent stalled (with its own single message)
   * if it stays silent for `stallAfterMs` — bounding transient failures to a
   * single retry window instead of unbounded retries.
   */
  private async handleNudgeFailure(
    team: EnsembleTeam,
    agentName: string,
    hostId: string | undefined,
    stateKey: string,
    lastMessageAt: string,
    nowMs: number,
    err: unknown,
  ): Promise<void> {
    const reason = err instanceof Error ? err.message : String(err)
    const iso = new Date(nowMs).toISOString()
    const sessionName = `${team.name}-${agentName}`
    const isLocal = !hostId || this.deps.isSelf(hostId)

    // Prefer asking the runtime whether the session still exists over
    // string-matching the error message — pasteFromFile/sendKeys error text
    // isn't a stable contract, but sessionExists() is part of the
    // AgentRuntime interface and is authoritative about session liveness.
    let sessionGone = false
    if (isLocal) {
      try {
        sessionGone = !(await this.deps.getRuntime().sessionExists(sessionName))
      } catch {
        // Couldn't determine liveness — don't assume the session is gone.
        sessionGone = false
      }
    }

    if (sessionGone) {
      console.warn(`[Watchdog] Agent ${agentName} in team ${team.id} session no longer exists; marking stalled`)
      this.deps.appendMessage(team.id, {
        id: uuidv4(),
        teamId: team.id,
        from: 'ensemble',
        to: 'team',
        content: `⚠️ Watchdog marked ${agentName} as stalled: session is gone (${reason})`,
        type: 'chat',
        timestamp: iso,
      })
      this.state.set(stateKey, { lastMessageAt, nudgedAt: iso, stalledAt: iso })
      return
    }

    this.deps.appendMessage(team.id, {
      id: uuidv4(),
      teamId: team.id,
      from: 'ensemble',
      to: 'team',
      content: `❌ Watchdog failed to nudge ${agentName}: ${reason}`,
      type: 'chat',
      timestamp: iso,
    })
    this.state.set(stateKey, { lastMessageAt, nudgedAt: iso })
  }
}

export { DEFAULT_POLL_INTERVAL_MS, DEFAULT_NUDGE_MS, DEFAULT_STALL_MS, WATCHDOG_NUDGE_TEXT }
