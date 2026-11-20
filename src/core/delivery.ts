/**
 * The one way text reaches an agent's terminal.
 *
 * Startup prompts, teammate messages, watchdog nudges and staged-workflow
 * prompts all come through `deliver`, because each of them needs the same three
 * guarantees and missing one produced a silent agent in a live run:
 *   - one delivery at a time per session, so two pastes never interleave in a
 *     composer (different sessions run in parallel);
 *   - a bounded queue per session, so an agent looping on team-say cannot grow
 *     memory without limit;
 *   - a paste is followed by `ensureSubmitted`: a paste alone never submits.
 */

import { getRuntime } from '../runtime/agent-runtime'
import type { AgentRuntime } from '../runtime/agent-runtime'
import { ensureSubmitted, waitForCommandAccepted } from './paste-submit'

/** Deliveries waiting or running per session; the next one is dropped. */
export const MAX_PENDING_DELIVERIES = 50

export type DeliveryRuntime = Pick<AgentRuntime, 'exists' | 'paste' | 'sendKeys' | 'screen'>

export interface DeliverOptions {
  /** The adapter's `inputMethod`. `sendKeys` types the text and presses Enter; anything else pastes it. */
  inputMethod?: 'pasteFromFile' | 'sendKeys'
  /** The adapter's `pasteMarker`: what a parked, unsubmitted paste looks like on screen. */
  pasteMarker?: string
  /** Defaults to the installed runtime. Looked up when the delivery runs, not when it is queued. */
  runtime?: DeliveryRuntime
}

/**
 * - `delivered`: the text was written and submitted (or confirmed submitted).
 * - `dropped`: the session already has MAX_PENDING_DELIVERIES waiting; nothing was written.
 * - `gone`: the session no longer exists; nothing was written.
 */
export type DeliveryOutcome = 'delivered' | 'dropped' | 'gone'

const queues = new Map<string, Promise<unknown>>()
const pending = new Map<string, number>()

function runExclusive<T>(sessionName: string, task: () => Promise<T>): Promise<T> {
  pending.set(sessionName, (pending.get(sessionName) ?? 0) + 1)
  const run = (queues.get(sessionName) ?? Promise.resolve()).then(task)
  const tail = run.catch(() => {}).then(() => {
    const left = (pending.get(sessionName) ?? 1) - 1
    if (left > 0) pending.set(sessionName, left)
    else pending.delete(sessionName)
    if (queues.get(sessionName) === tail) queues.delete(sessionName)
  })
  queues.set(sessionName, tail)
  return run
}

/** Number of deliveries waiting or running for a session. */
export function pendingDeliveries(sessionName: string): number {
  return pending.get(sessionName) ?? 0
}

/**
 * Queue `text` for a session and resolve once it has been written and submitted.
 * Rejects with the runtime's error when the write fails; the queue carries on
 * with the next delivery either way.
 */
export function deliver(sessionName: string, text: string, options: DeliverOptions = {}): Promise<DeliveryOutcome> {
  if (pendingDeliveries(sessionName) >= MAX_PENDING_DELIVERIES) return Promise.resolve('dropped')

  return runExclusive(sessionName, async (): Promise<DeliveryOutcome> => {
    const runtime = options.runtime ?? getRuntime()
    // A finished agent's terminal is gone: pasting would only raise "PTY session not found".
    if (!runtime.exists(sessionName)) return 'gone'
    await writeAndSubmit(runtime, sessionName, text, options)
    return 'delivered'
  })
}

async function writeAndSubmit(runtime: DeliveryRuntime, sessionName: string, text: string, options: DeliverOptions): Promise<void> {
  if (options.inputMethod === 'sendKeys') {
    runtime.sendKeys(sessionName, text, { literal: true, enter: true })
  } else {
    // Paste, not typed input: typing breaks on ?, !, `, $ and \ in PowerShell and treats a newline as Enter.
    runtime.paste(sessionName, text)
  }
  await ensureSubmitted(runtime, sessionName, options.pasteMarker)
}

/**
 * - `delivered`: the command was accepted and the follow-up went in after it.
 * - `unconfirmed`: the command was written but the composer still showed it after the confirmation window; no follow-up was sent.
 * - `dropped` / `gone`: as for `deliver`; nothing was written.
 */
export type SkillDeliveryOutcome = 'delivered' | 'unconfirmed' | 'dropped' | 'gone'

/**
 * Fire a slash command at a session: `command` alone on its line, then a check that it left the composer
 * (`waitForCommandAccepted`, which presses a few extra Enters), then `followUp` as a second delivery.
 * All of it is one job in the session's queue, so no teammate message can land between the command and
 * the check, and the follow-up never lands on top of a command stuck in the composer.
 */
export function deliverSkillCommand(
  sessionName: string,
  command: { text: string; token: string; followUp: string },
  options: DeliverOptions = {},
): Promise<SkillDeliveryOutcome> {
  if (pendingDeliveries(sessionName) >= MAX_PENDING_DELIVERIES) return Promise.resolve('dropped')

  return runExclusive(sessionName, async (): Promise<SkillDeliveryOutcome> => {
    const runtime = options.runtime ?? getRuntime()
    if (!runtime.exists(sessionName)) return 'gone'
    await writeAndSubmit(runtime, sessionName, command.text, options)
    if (!await waitForCommandAccepted(runtime, sessionName, command.token)) return 'unconfirmed'
    await writeAndSubmit(runtime, sessionName, command.followUp, options)
    return 'delivered'
  })
}

/** Like `deliver`, for callers that cannot carry on without the text arriving: anything but `delivered` throws. */
export async function deliverStrict(sessionName: string, text: string, options: DeliverOptions = {}): Promise<void> {
  const outcome = await deliver(sessionName, text, options)
  if (outcome === 'gone') throw new Error(`PTY session not found: ${sessionName}`)
  if (outcome === 'dropped') {
    throw new Error(`${MAX_PENDING_DELIVERIES} messages are already waiting for the terminal of ${sessionName}`)
  }
}
