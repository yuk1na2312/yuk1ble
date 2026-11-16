/**
 * The human-readable summary.txt written when a team is disbanded.
 */

import fs from 'fs'
import path from 'path'
import { getTeam, getMessages } from './ensemble-registry'
import { getAgentTokenUsage } from './agent-spawner'
import { agentSessionName } from './session-name'
import { getFeedFile } from './ensemble-paths'
import { collabSummaryFile, scrubCollabRuntimePaths } from './collab-paths'
import { EXPLICIT_DONE_SENTINEL } from './prompts'

export function formatDuration(durationMs: number): string {
  const durationMin = Math.max(0, Math.round(durationMs / 60000))
  return durationMin >= 60
    ? `${Math.floor(durationMin / 60)}h ${durationMin % 60}m`
    : `${durationMin}m`
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
        const sessionName = agentSessionName(team, agent)
        tokenUsageMap[agent.name] = await getAgentTokenUsage(sessionName, agent.program)
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
