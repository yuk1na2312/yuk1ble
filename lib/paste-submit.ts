/**
 * Making a pasted prompt actually submit.
 *
 * Agent CLIs buffer a large paste in their composer instead of submitting it:
 * claude renders "[Pasted text …]", codex "[Pasted Content N chars]". Writing
 * a trailing CR in the same burst does NOT submit it — a standalone Enter,
 * sent a moment later, does.
 *
 * Verified live against codex v0.147 on Windows: after `PtyRuntime.paste` the
 * composer held "[Pasted Content 1929 chars]" indefinitely; one Enter submitted
 * it and the agent replied. Without this, an agent silently receives neither its
 * startup prompt nor any teammate message, and merely looks stalled.
 */

import type { AgentRuntime } from './agent-runtime'

/** Regex source of the default parked-paste indicator; an adapter's `pasteMarker` overrides it. */
export const DEFAULT_PASTE_MARKER = '\\[Pasted (?:text|Content)'
export const PASTE_NOT_SUBMITTED = new RegExp(DEFAULT_PASTE_MARKER, 'i')

/** Escalating waits: most sessions submit on the first Enter. */
const RETRY_DELAYS_MS = [1500, 3000, 6000]

export async function ensureSubmitted(
  runtime: Pick<AgentRuntime, 'screen' | 'sendKeys'>,
  sessionName: string,
  pasteMarker: RegExp | string = PASTE_NOT_SUBMITTED,
): Promise<void> {
  const parked = typeof pasteMarker === 'string' ? new RegExp(pasteMarker, 'i') : pasteMarker
  for (const delayMs of RETRY_DELAYS_MS) {
    await new Promise(resolve => setTimeout(resolve, delayMs))
    let pane: string
    try {
      pane = runtime.screen(sessionName, 80)
    } catch {
      return // Session is gone; nothing to submit into.
    }
    if (!parked.test(pane)) return
    runtime.sendKeys(sessionName, 'Enter')
  }
}
