/**
 * Watches running teams: the done sentinel, idle auto-disband, and the agent
 * watchdog. It decides when a team should end; ending it is the service's job,
 * handed in as `disband`.
 */

import { randomUUID } from 'crypto'
import type { EnsembleTeam, EnsembleMessage } from '../types/ensemble'
import { getTeam, updateTeam, loadTeams, appendMessage, getMessages } from './ensemble-registry'
import { getRuntime } from './agent-runtime'
import { resolveAgentProgram } from './agent-config'
import { AgentWatchdog } from './agent-watchdog'
import { bus } from './bus'
import { EXPLICIT_DONE_SENTINEL } from './prompts'
import { formatDuration } from './summary'

const IDLE_CHECK_INTERVAL_MS = 15_000
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
const MIN_MESSAGES_BEFORE_AUTO_DISBAND = 10

export class TeamSupervisor {
  private readonly disbandingTeams = new Set<string>()
  private readonly idleCheckTimer: NodeJS.Timeout
  private readonly watchdog: AgentWatchdog
  private readonly unsubscribeMessages: () => void

  /** `disband` ends a team: writes its summary, kills its sessions. Supplied by the service. */
  constructor(private readonly disband: (teamId: string) => Promise<unknown>) {
    this.unsubscribeMessages = bus.on('message', message => this.onMessage(message))
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

  /**
   * The done sentinel from an agent. Runs synchronously inside the store's
   * emit, so the disband itself is deferred to a microtask: starting it here
   * would append its own message before later listeners have seen this one.
   */
  private onMessage(message: EnsembleMessage): void {
    if (message.content?.trim() !== EXPLICIT_DONE_SENTINEL) return
    const team = getTeam(message.teamId)
    if (!team || team.status !== 'active') return

    const activeNames = new Set(team.agents.filter(a => a.status === 'active').map(a => a.name))
    const sentinelSenders = new Set(
      getMessages(team.id)
        .filter(m => activeNames.has(m.from) && m.content?.trim() === EXPLICIT_DONE_SENTINEL)
        .map(m => m.from),
    )
    // With two agents this is "both"; with N it is every one of them.
    if (activeNames.size === 0 || sentinelSenders.size < activeNames.size) return
    queueMicrotask(() => { void this.autoDisband(team, `every active agent sent ${EXPLICIT_DONE_SENTINEL}`) })
  }

  /** Disband teams that have gone quiet. Elapsed time is the only condition here, so it is a timer. */
  async checkIdleTeams(): Promise<void> {
    const teams = loadTeams().filter(team => team.status === 'active')

    for (const team of teams) {
      const reason = this.idleReason(team)
      if (reason) await this.autoDisband(team, reason)
    }
  }

  private async autoDisband(team: EnsembleTeam, reason: string): Promise<void> {
    if (this.disbandingTeams.has(team.id)) return
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

      await this.disband(team.id) // writes the summary before killing sessions
    } catch (err) {
      console.error(`[Ensemble] Auto-disband failed for ${team.id}:`, err)
    } finally {
      this.disbandingTeams.delete(team.id)
    }
  }

  /** Why this team has gone idle long enough to disband, or null to leave it running. */
  private idleReason(team: EnsembleTeam): string | null {
    const nonEnsembleMessages = getMessages(team.id).filter(message => message.from !== 'ensemble')
    const lastMessage = nonEnsembleMessages[nonEnsembleMessages.length - 1]
    if (!lastMessage) return null

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
    this.unsubscribeMessages()
    this.watchdog.stop()
  }
}
