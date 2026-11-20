/**
 * Firing one of an agent's installed skills at it (POST /api/ensemble/teams/:id/skill), and the catalog
 * the "/" picker lists (GET /api/ensemble/skills). A sibling of sendTeamMessage, not a mode of it: a slash
 * command only parses alone on its line, which the team-message wrapper prevents.
 */

import { randomUUID } from 'crypto'
import type { EnsembleMessage, EnsembleTeam, EnsembleTeamAgent, ServiceResult } from '../types'
import { getTeam, appendMessage } from './store'
import { deliverSkillCommand, MAX_PENDING_DELIVERIES } from './delivery'
import { sendTeamMessage, type SendMessageResult } from './messaging'
import { agentSessionName } from './session-name'
import { getRuntime } from '../runtime/agent-runtime'
import { resolveAgentProgram } from '../adapters/agent-config'
import { getSkillCatalog, type SkillCatalog } from '../adapters/skills'

/** The follow-up after the command: short, so it derails as little as possible of a thought the agent is mid-way through. */
const NUDGE = `→ When you're done, share what you did via team-say.`
export const MAX_SKILL_ARGS_LENGTH = 4000

/**
 * The directory an agent's project skills are read from: the worktree it was spawned into, else the team's
 * working directory, else the server's own (what a team created without one runs in). One function for the
 * catalog route and the invoke route, so a token the picker never listed can never be accepted.
 */
export function resolveAgentProjectDir(team: EnsembleTeam, agent: EnsembleTeamAgent): string {
  return agent.worktreePath || team.workingDirectory || process.cwd()
}

function findAgent(teamId: string, agentName: string): ServiceResult<{ team: EnsembleTeam; agent: EnsembleTeamAgent }> {
  const team = getTeam(teamId)
  if (!team) return { error: 'Team not found', status: 404 }
  const agent = team.agents.find(a => a.name === agentName)
  if (!agent) return { error: 'Agent not found', status: 404 }
  return { data: { team, agent }, status: 200 }
}

/** The catalog of one agent. Addressed by team and agent only: the client never names a directory. */
export async function getAgentSkills(teamId: string, agentName: string): Promise<ServiceResult<SkillCatalog>> {
  const found = findAgent(teamId, agentName)
  if (!found.data) return { error: found.error, status: found.status }
  const { team, agent } = found.data
  return { data: await getSkillCatalog(agent.program, resolveAgentProjectDir(team, agent)), status: 200 }
}

/**
 * Validate, put one `command` message in the feed, and deliver in the background (the result's `delivery`,
 * which never rejects; a failure is an `ensemble` note in the feed).
 *
 * The token must be in the agent's live catalog: this raw channel carries a slash command the user really
 * has installed, not arbitrary text typed into a terminal. `args` is free text but a single line of printable
 * characters: a control character in typed input could submit the line early and send a second one.
 */
export async function invokeAgentSkill(teamId: string, agentName: string, token: string, args: string): Promise<SendMessageResult> {
  const found = findAgent(teamId, agentName)
  if (!found.data) return { error: found.error, status: found.status }
  const { team, agent } = found.data

  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(args)) return { error: 'args must be a single line of text', status: 400 }
  if (args.length > MAX_SKILL_ARGS_LENGTH) return { error: `args is longer than ${MAX_SKILL_ARGS_LENGTH} characters`, status: 400 }

  const catalog = await getSkillCatalog(agent.program, resolveAgentProjectDir(team, agent))
  if (catalog.invocation === 'none') return { error: catalog.detail || `skills are not supported for ${agent.program}`, status: 400 }
  const skill = catalog.skills.find(s => s.token === token)
  if (!skill) return { error: `unknown skill "${token}" for ${agentName}`, status: 400 }

  const sessionName = agentSessionName(team, agent)
  if (!getRuntime().exists(sessionName)) return { error: 'agent session is not running', status: 409 }

  // `prose` never touches the raw channel: an ordinary, wrapped team message.
  if (catalog.invocation === 'prose') {
    return sendTeamMessage(teamId, agentName, `Use your "${skill.name}" skill${args ? `: ${args}` : ''}`)
  }

  const text = `/${token}${args ? ` ${args}` : ''}`
  const message: EnsembleMessage = {
    id: randomUUID(), teamId, from: 'user', to: agentName, content: text,
    type: 'command', timestamp: new Date().toISOString(),
  }
  // The one feed entry of a fired skill: the follow-up nudge is delivery plumbing, not something the user said.
  appendMessage(teamId, message)

  const note = (content: string): void => {
    appendMessage(teamId, {
      id: randomUUID(), teamId, from: 'ensemble', to: 'team', content,
      type: 'chat', timestamp: new Date().toISOString(),
    })
  }
  const delivery = deliverSkillCommand(sessionName, { text, token, followUp: NUDGE }, {
    inputMethod: resolveAgentProgram(agent.program)?.inputMethod,
    pasteMarker: resolveAgentProgram(agent.program)?.pasteMarker,
  }).then(outcome => {
    if (outcome === 'unconfirmed') {
      note(`⚠️ /${token} may not have been accepted by ${agentName}: the composer still showed the command after 10s. Skipped the follow-up.`)
    } else if (outcome === 'dropped') {
      note(`❌ Delivery of /${token} to ${agentName} dropped: ${MAX_PENDING_DELIVERIES} messages are already waiting for its terminal`)
    } else if (outcome === 'gone') {
      note(`❌ Delivery of /${token} to ${agentName} failed: its terminal is gone`)
    }
  }).catch((err: unknown) => {
    note(`❌ Delivery of /${token} to ${agentName} failed: ${err instanceof Error ? err.message : String(err)}`)
  })

  return { data: { message }, status: 200, delivery }
}
