/**
 * Deciding whether an agent's terminal screen means "ready for input".
 *
 * Kept apart from the service so it stays pure and directly testable: these
 * three predicates are the whole difference between a team that starts and a
 * team that burns its readiness window staring at a screen it doesn't
 * recognise.
 */

/** The first configured marker present on screen, if any. */
export function matchReadyMarker(pane: string, markers: string[]): string | undefined {
  return markers.find(marker => pane.includes(marker))
}

/**
 * True when the last thing on screen is a bare PowerShell prompt — i.e. the
 * agent CLI has not started yet, or has already exited back to the shell.
 * Such a screen is perfectly still, so `isQuiescentReady` must never read it
 * as "ready" and paste a prompt into PowerShell.
 */
export function endsAtShellPrompt(pane: string): boolean {
  const lines = pane.split('\n').map(line => line.trimEnd()).filter(line => line.trim())
  return /^PS [^>]*>\s*$/.test(lines[lines.length - 1] ?? '')
}

/**
 * Fallback for when no marker matches: a CLI that is starting up redraws
 * constantly (spinners, progress, hook output), so a screen that has been
 * byte-identical for `quiescentMs` is an agent sitting at a prompt we simply
 * don't recognise. Empty screens and shell prompts are excluded — they are
 * still for the opposite reason.
 */
export function isQuiescentReady(
  pane: string, unchangedForMs: number, quiescentMs: number,
): boolean {
  if (!pane.trim()) return false
  if (endsAtShellPrompt(pane)) return false
  return unchangedForMs >= quiescentMs
}
