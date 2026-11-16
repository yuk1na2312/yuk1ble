/**
 * A message into a team's feed, and on to the terminals of its recipients.
 */

import { randomUUID } from 'crypto'
import type { EnsembleMessage, ServiceResult } from '../types/ensemble'
import { getTeam, appendMessage } from './ensemble-registry'
import { deliver, MAX_PENDING_DELIVERIES } from './delivery'
import { resolveAgentProgram } from './agent-config'

export interface SendMessageResult extends ServiceResult<{ message: EnsembleMessage }> {
  /**
   * Settles when the message has been pasted into every recipient's terminal and
   * submitted. The HTTP route does not wait for it: the message is in the feed
   * before the response, and delivery carries on through the per-session queue.
   * Never rejects; a failed delivery is written to the feed. Tests await it.
   */
  delivery?: Promise<void>
}

export async function sendTeamMessage(
  teamId: string, to: string, content: string, from?: string,
  existingId?: string, existingTimestamp?: string,
): Promise<SendMessageResult> {
  const team = getTeam(teamId)
  if (!team) return { error: 'Team not found', status: 404 }
  if (typeof content !== 'string' || !content.trim()) return { error: 'content is required', status: 400 }

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

  const note = (text: string): void => {
    appendMessage(teamId, {
      id: randomUUID(), teamId, from: 'ensemble', to: 'team', content: text,
      type: 'chat', timestamp: new Date().toISOString(),
    })
  }

  // Wrap the message with sender context + a response nudge
  const deliveryText = [
    `[Team message from ${sender}]: ${content}`,
    `→ Respond with team-say. Then run team-read to check for more messages.`,
  ].join('\n')

  const delivery = Promise.all(recipients.map(async targetAgent => {
    const sessionName = `${team.name}-${targetAgent.name}`
    try {
      // No inputMethod: messages are always pasted, never typed. A session that is gone (agent finished) is skipped.
      const outcome = await deliver(sessionName, deliveryText, {
        pasteMarker: resolveAgentProgram(targetAgent.program)?.pasteMarker,
      })
      if (outcome === 'dropped') {
        note(`❌ Delivery to ${targetAgent.name} dropped: ${MAX_PENDING_DELIVERIES} messages are already waiting for its terminal`)
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      note(`❌ Delivery to ${targetAgent.name} failed: ${reason}`)
    }
  })).then(() => undefined, err => {
    console.error(`[Ensemble] Message delivery for ${teamId} failed unexpectedly:`, err)
  })

  return { data: { message }, status: 200, delivery }
}
