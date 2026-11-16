/**
 * Waiting for a freshly spawned agent CLI to reach its input prompt.
 *
 * Every dependency is injected, so this is testable against a scripted screen
 * and carries no knowledge of any particular CLI: its ready markers and startup
 * gates arrive as data from the adapter (agents.json).
 *
 * Order of checks on each pass, which must not change:
 *   1. the wait was aborted (team disbanded)
 *   2. the session exited
 *   3. a startup gate is on screen: answer it and look again. Gates come BEFORE
 *      the markers because a marker can also be a modal's selection cursor, and
 *      pasting the task into a dialog is the failure this ordering prevents.
 *   4. a ready marker is on screen
 *   5. the screen has not changed for `quiescentMs` (an unrecognised prompt)
 *
 * When a pass finds nothing to act on it waits for the PTY to emit output
 * (re-checking DATA_DEBOUNCE_MS after the first chunk of a burst) or for
 * POLL_INTERVAL_MS to pass, whichever is first. The timer is what drives the
 * quiescence clock and the timeout, and it keeps working if the output feed does not.
 */

import type { AgentRuntime } from './agent-runtime'
import type { AgentGate } from '../types/agent-program'
import { matchReadyMarker, isQuiescentReady } from './pane-readiness'

/** A gate is abandoned after this many answers so a screen that keeps matching cannot starve the ready check. */
export const MAX_GATE_ATTEMPTS = 5
/** The same gate is not answered again within this window: no key-repeat storms. */
const GATE_DEBOUNCE_MS = 3000
/** Longest wait between two passes. */
const POLL_INTERVAL_MS = 1000
/** A burst of PTY output triggers a pass this long after its first chunk. */
export const DATA_DEBOUNCE_MS = 250

export interface ReadinessOptions {
  runtime: Pick<AgentRuntime, 'screen' | 'sendKeys' | 'exists' | 'onData'>
  sessionName: string
  readyMarkers: string[]
  gates: AgentGate[]
  /** Checked at the top of every pass; true ends the wait with `false`. */
  isAborted: () => boolean
  /** Why the wait was aborted, for the log line. */
  abortReason: string
  maxWaitMs: number
  /** Unchanged-screen window that stands in for an unrecognised ready marker. */
  quiescentMs: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  env?: NodeJS.ProcessEnv
}

/** What to send for a gate: its trust variant when the gate's env switch is on. */
function gateKeys(gate: AgentGate, env: NodeJS.ProcessEnv): string[] {
  return gate.trustEnv && gate.trustKeys && env[gate.trustEnv] === '1' ? gate.trustKeys : gate.keys
}

/** Resolves true once the agent is at its prompt (or looks settled), false on abort, exit or timeout. Never rejects on a screen error. */
export async function waitForReady(options: ReadinessOptions): Promise<boolean> {
  const { runtime, sessionName } = options
  let wake: (() => void) | undefined
  let burstTimer: ReturnType<typeof setTimeout> | undefined
  let dataSeen = false

  const scheduleBurst = (): void => {
    burstTimer ??= setTimeout(() => wake?.(), DATA_DEBOUNCE_MS)
  }
  let unsubscribe = (): void => {}
  try {
    unsubscribe = runtime.onData(sessionName, () => {
      dataSeen = true
      if (wake) scheduleBurst()
    })
  } catch {
    // No output feed (session already gone, listener cap): the poll timer alone drives the loop.
  }

  // Resolves on the next burst of output or after POLL_INTERVAL_MS. Output that arrived while a pass was running counts.
  const nap = (): Promise<void> => new Promise<void>(resolve => {
    let tick: ReturnType<typeof setTimeout> | undefined
    const mine = (): void => {
      if (wake !== mine) return // a stale timer from an earlier nap
      wake = undefined
      clearTimeout(burstTimer)
      burstTimer = undefined
      clearTimeout(tick)
      dataSeen = false
      resolve()
    }
    wake = mine
    if (dataSeen) scheduleBurst()
    if (options.sleep) void options.sleep(POLL_INTERVAL_MS).then(mine)
    else tick = setTimeout(mine, POLL_INTERVAL_MS)
  })

  try {
    return await pollUntilReady(options, nap)
  } finally {
    unsubscribe()
    clearTimeout(burstTimer)
    wake = undefined
  }
}

async function pollUntilReady(options: ReadinessOptions, nap: () => Promise<void>): Promise<boolean> {
  const { runtime, sessionName, readyMarkers, isAborted, maxWaitMs, quiescentMs } = options
  const now = options.now ?? Date.now
  const env = options.env ?? process.env
  const gates = options.gates.map(gate => ({ gate, pattern: new RegExp(gate.pattern, 'i') }))

  const start = now()
  const gateAttempts = new Map<string, number>()
  let lastGateName = ''
  let lastGateHandledAt = 0
  let lastError = ''
  let lastPane = ''
  let lastPaneChangedAt = start

  // A session that has exited is never going to become ready. An unusable exists() is "unknown": keep waiting.
  const sessionHasExited = (): boolean => {
    try {
      return runtime.exists(sessionName) === false
    } catch {
      return false
    }
  }

  while (now() - start < maxWaitMs) {
    if (isAborted()) {
      console.log(`[Ensemble] ${sessionName} readiness wait aborted — ${options.abortReason}`)
      return false
    }
    // Report an exit distinctly instead of burning the whole window and blaming a timeout.
    if (sessionHasExited()) {
      console.error(`[Ensemble] ${sessionName} exited before becoming ready (${Math.round((now() - start) / 1000)}s)`)
      return false
    }
    try {
      const output = runtime.screen(sessionName, 50)
      const found = gates.find(({ gate, pattern }) =>
        pattern.test(output) && (gateAttempts.get(gate.name) ?? 0) < MAX_GATE_ATTEMPTS
      )
      if (found) {
        const { gate } = found
        const at = now()
        if (gate.name !== lastGateName || at - lastGateHandledAt >= GATE_DEBOUNCE_MS) {
          const sendOptions = gate.literal || gate.enter
            ? { ...(gate.literal ? { literal: true } : {}), ...(gate.enter ? { enter: true } : {}) }
            : undefined
          for (const key of gateKeys(gate, env)) {
            runtime.sendKeys(sessionName, key, sendOptions)
          }
          const attempts = (gateAttempts.get(gate.name) ?? 0) + 1
          gateAttempts.set(gate.name, attempts)
          lastGateName = gate.name
          lastGateHandledAt = at
          console.log(`[Ensemble] Auto-confirmed ${gate.name} in ${sessionName} (attempt ${attempts}/${MAX_GATE_ATTEMPTS})`)
          if (attempts >= MAX_GATE_ATTEMPTS) {
            console.warn(`[Ensemble] ${gate.name} did not clear in ${sessionName}; ignoring it and checking readiness directly`)
          }
        }
        await nap()
        continue
      }
      const marker = matchReadyMarker(output, readyMarkers)
      if (marker) {
        console.log(
          `[Ensemble] ${sessionName} is ready (${Math.round((now() - start) / 1000)}s,`
          + ` matched ${JSON.stringify(marker)})`
        )
        return true
      }

      // Fallback: no marker matched, but the CLI has painted a screen that has
      // since stopped changing. A working agent redraws constantly while it
      // starts up (spinners, progress, hook output), so a screen that is
      // byte-identical for `quiescentMs` is an agent sitting at its prompt
      // behind a marker we don't recognise. Without this a single UI tweak
      // upstream costs the whole readiness window.
      if (output !== lastPane) {
        lastPane = output
        lastPaneChangedAt = now()
      } else if (isQuiescentReady(output, now() - lastPaneChangedAt, quiescentMs)) {
        console.warn(
          `[Ensemble] ${sessionName} assumed ready (${Math.round((now() - start) / 1000)}s):`
          + ` no marker in ${JSON.stringify(readyMarkers)}, but the screen has been idle`
          + ` for ${quiescentMs / 1000}s`
        )
        return true
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
    }
    await nap()
  }
  console.error(
    `[Ensemble] ${sessionName} did not become ready within ${maxWaitMs / 1000}s`
    + ` (looking for ${JSON.stringify(readyMarkers)})`
    + (lastError ? ` — last error: ${lastError}` : '')
  )
  // Without this the timeout is undiagnosable after the fact: the session is
  // killed on disband and its screen goes with it. Log what the agent was
  // actually showing so the next occurrence explains itself.
  const tail = lastPane.split('\n').map(line => line.trimEnd()).filter(line => line.trim()).slice(-12)
  console.error(
    `[Ensemble] ${sessionName} last screen (${tail.length} lines):\n`
    + (tail.length ? tail.join('\n') : '(nothing — the session produced no output)')
  )
  return false
}
