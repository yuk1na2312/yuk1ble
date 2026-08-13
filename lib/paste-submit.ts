/**
 * Making a pasted prompt actually submit.
 *
 * Agent CLIs buffer a large paste in their composer instead of submitting it:
 * claude renders "[Pasted text …]", codex "[Pasted Content N chars]". Writing
 * a trailing CR in the same burst does NOT submit it — a standalone Enter,
 * sent a moment later, does.
 *
 * Verified live against codex v0.147 on Windows: after `pasteFromFile` the
 * composer held "[Pasted Content 1929 chars]" indefinitely; one Enter submitted
 * it and the agent replied. Without this, an agent silently receives neither its
 * startup prompt nor any teammate message, and merely looks stalled.
 */

import type { AgentRuntime } from './agent-runtime'

export const PASTE_NOT_SUBMITTED = /\[Pasted (?:text|Content)/i

/** Escalating waits: most sessions submit on the first Enter. */
const RETRY_DELAYS_MS = [1500, 3000, 6000]

export async function ensureSubmitted(
  runtime: Pick<AgentRuntime, 'capturePane' | 'sendKeys'>,
  sessionName: string,
): Promise<void> {
  for (const delayMs of RETRY_DELAYS_MS) {
    await new Promise(resolve => setTimeout(resolve, delayMs))
    let pane: string
    try {
      pane = await runtime.capturePane(sessionName, 80)
    } catch {
      return // Session is gone; nothing to submit into.
    }
    if (!PASTE_NOT_SUBMITTED.test(pane)) return
    await runtime.sendKeys(sessionName, 'Enter')
  }
}
