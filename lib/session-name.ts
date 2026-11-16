/**
 * The runtime session name an agent's terminal gets. The spawner names the PTY
 * session with this; anything that must recognise a session as an agent's
 * (the input routes) uses it too, so the two cannot drift apart.
 */

/** A runtime session name from an agent name. */
export function computeSessionName(agentName: string): string {
  return agentName.replace(/[^a-zA-Z0-9\-_.]/g, '')
}
