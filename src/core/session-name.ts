/**
 * The runtime session name of an agent's terminal. This is the only place a session
 * name is computed: the spawner names the PTY with it, readiness, delivery, the
 * watchdog, the staged workflow, the summary and the input routes find the PTY
 * with it, and the store stamps it on every agent so the GUI never rebuilds it.
 */

import type { EnsembleTeam, EnsembleTeamAgent } from '../types'

/** What the runtime accepts in a session name; everything else is stripped. */
const STRIPPED = /[^a-zA-Z0-9\-_.]/g

/** The sanitized form of a name: what is left once characters the runtime rejects are removed. */
export function sanitizeSessionPart(name: string): string {
  return name.replace(STRIPPED, '')
}

/** The name an agent gets from its program and its place in the team: `codex-1`, `claude-2`. */
export function agentNameFor(program: string, index: number): string {
  return `${program.toLowerCase().replace(/\s+/g, '-').split('-')[0]}-${index + 1}`
}

/** The session name of agent `agentName` of the team called `teamName`. */
export function computeSessionName(teamName: string, agentName: string): string {
  return sanitizeSessionPart(`${teamName}-${agentName}`)
}

/** The session name of one of `team`'s agents. */
export function agentSessionName(team: Pick<EnsembleTeam, 'name'>, agent: Pick<EnsembleTeamAgent, 'name'>): string {
  return computeSessionName(team.name, agent.name)
}
