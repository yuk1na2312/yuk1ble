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

import type { AgentRuntime } from '../runtime/agent-runtime'

/** Regex source of the default parked-paste indicator; an adapter's `pasteMarker` overrides it. */
export const DEFAULT_PASTE_MARKER = '\\[Pasted (?:text|Content)'
export const PASTE_NOT_SUBMITTED = new RegExp(DEFAULT_PASTE_MARKER, 'i')

export const COMMAND_POLL_MS = 750
export const COMMAND_TIMEOUT_MS = 10_000
export const COMMAND_MAX_EXTRA_ENTERS = 2

/**
 * Confirms a just-submitted slash command left the composer, pressing at most COMMAND_MAX_EXTRA_ENTERS
 * standalone Enters while it has not. Typing "/" opens the CLI's own command menu, and an Enter that
 * lands while it is open can select the highlighted entry instead of submitting the line, so
 * `ensureSubmitted` (which only knows a parked paste) cannot vouch for a short command.
 *
 * UNVERIFIED signature: "the last non-empty line of the screen still holds `/<token>`" has not been
 * checked against a live capture of a real CLI's menu; replace it once one exists (see
 * tests/fixtures/screens.ts for how those captures are kept). Resolves false on timeout or a gone session.
 */
export async function waitForCommandAccepted(
  runtime: Pick<AgentRuntime, 'screen' | 'sendKeys'>,
  sessionName: string,
  token: string,
): Promise<boolean> {
  let entersSent = 0
  for (let polled = 0; polled <= COMMAND_TIMEOUT_MS / COMMAND_POLL_MS; polled++) {
    try {
      const screen = runtime.screen(sessionName, 80)
      const lastLine = screen.split(/\r?\n/).filter(line => line.trim()).pop() ?? ''
      if (!lastLine.includes(`/${token}`)) return true
      if (entersSent < COMMAND_MAX_EXTRA_ENTERS) {
        runtime.sendKeys(sessionName, 'Enter')
        entersSent++
      }
    } catch {
      return false // the session is gone: nothing left to confirm
    }
    await new Promise(resolve => setTimeout(resolve, COMMAND_POLL_MS))
  }
  return false
}

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
