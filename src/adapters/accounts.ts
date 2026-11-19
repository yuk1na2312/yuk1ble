/**
 * Account status: which account each agent CLI is signed in as, behind GET /api/ensemble/accounts.
 *
 * SECURITY: strictly read-only. It runs only the status subcommand an adapter names in agents.json
 * (`account`), never signs in or out and never reads a credential file. CLI output can carry tokens,
 * so every result is rebuilt from the allowlist in `build` (program, state, account, plan, detail):
 * the raw output is parsed here and then dropped, never logged, stored or returned.
 */

import { execFile } from 'child_process'
import { listAgentPrograms } from './agent-config'
import { findOnPath, killProcessTree } from '../runtime/win-process'
import type { AgentAccountJson, AgentAccountText, AgentProgram } from './types'

export type AccountState = 'signed-in' | 'signed-out' | 'unsupported' | 'error'

export interface AccountStatus {
  program: string
  state: AccountState
  /** Identity label, e.g. an email or account name. */
  account?: string
  /** Plan label, e.g. "Max". */
  plan?: string
  /** Human-readable explanation, for the unsupported and error states. */
  detail?: string
}

export const ACCOUNT_PROBE_TIMEOUT_MS = 5000
export const ACCOUNTS_CACHE_MS = 60_000
const MAX_OUTPUT_BYTES = 64 * 1024
const MAX_FIELD_CHARS = 200

const TIMED_OUT = new Error('account probe timed out')

/** Keyed by program name, so bounded by the number of programs in agents.json. Holds the promise: concurrent requests share one probe. */
const cache = new Map<string, { at: number; status: Promise<AccountStatus> }>()

/** Clear the cache (tests). */
export function clearAccountsCache(): void {
  cache.clear()
}

/**
 * Key-shaped text: an `sk-` key or a long unbroken run of key characters. account and plan are
 * captured from CLI output by patterns anyone can edit in agents.json, so a loose pattern must not
 * be able to carry a key to the browser (e.g. "Logged in using an API key - sk-…").
 */
const KEY_LIKE = /sk-[\w-]+|[A-Za-z0-9_+/=-]{24,}/g

function build(program: string, state: AccountState, fields: { account?: string; plan?: string; detail?: string } = {}): AccountStatus {
  const status: AccountStatus = { program, state }
  for (const key of ['account', 'plan', 'detail'] as const) {
    let value = fields[key]?.trim()
    if (value && key !== 'detail') value = value.replace(KEY_LIKE, '[redacted]')
    value = value?.slice(0, MAX_FIELD_CHARS)
    if (value) status[key] = value
  }
  return status
}

/**
 * Run `command args` and return its output, stdout or else stderr (some CLIs answer on stderr; a
 * "Not logged in" exit code is still an answer). Goes through `cmd.exe /d /c` because npm installs
 * CLIs as .cmd shims, which Node will not execFile without a shell; that is safe here because the
 * command and args come only from agents.json, where the loader rejects any shell metacharacter.
 * Bounded by a timeout that kills the whole process tree. Never leaves a timer behind.
 */
function runProbe(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    let finished = false
    const timer = setTimeout(() => finish(() => {
      if (child.pid) void killProcessTree(child.pid)
      reject(TIMED_OUT)
    }), ACCOUNT_PROBE_TIMEOUT_MS)
    timer.unref()
    const finish = (settle: () => void): void => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      settle()
    }
    const child = execFile(
      process.env['ComSpec'] || 'cmd.exe',
      ['/d', '/c', command, ...args],
      { windowsHide: true, maxBuffer: MAX_OUTPUT_BYTES },
      (error, stdout, stderr) => finish(() => {
        const text = stdout.trim() ? stdout : stderr
        if (error && !text.trim()) reject(error)
        else resolve(text)
      }),
    )
  })
}

const isEnoent = (err: unknown): boolean => typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT'

function parseJson(program: string, raw: string, spec: AgentAccountJson): AccountStatus {
  const parsed: unknown = JSON.parse(raw)
  const record: Record<string, unknown> = typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {}
  // Only the keys the adapter names are ever read: anything else in the output (a token) is never looked at.
  const first = <T>(keys: string[], type: 'boolean' | 'string'): T | undefined => {
    for (const key of keys) {
      const value = record[key]
      if (typeof value === type && (type === 'boolean' || (value as string).trim())) return value as T
    }
    return undefined
  }
  const signedIn = first<boolean>(spec.signedIn, 'boolean')
  const account = first<string>(spec.account, 'string')
  const plan = first<string>(spec.plan, 'string')
  if (signedIn === false) return build(program, 'signed-out')
  if (signedIn === true || account) return build(program, 'signed-in', { account, plan })
  return build(program, 'error', { detail: `unrecognized ${program} account status output` })
}

function parseText(program: string, raw: string, spec: AgentAccountText): AccountStatus {
  const text = raw.trim()
  if (!text) return build(program, 'error', { detail: `empty ${program} account status output` })
  const test = (source: string): boolean => new RegExp(source, 'i').test(text)
  if (test(spec.signedOut)) return build(program, 'signed-out')
  if (!test(spec.signedIn)) return build(program, 'error', { detail: `unrecognized ${program} account status output` })
  // Only the capture groups are kept; the rest of the line (a trailing token, say) is dropped.
  const capture = (sources: string[]): string | undefined => {
    for (const source of sources) {
      const value = new RegExp(source, 'i').exec(text)?.[1]
      if (value?.trim()) return value
    }
    return undefined
  }
  return build(program, 'signed-in', { account: capture(spec.account), plan: capture(spec.plan) })
}

async function probe(program: AgentProgram): Promise<AccountStatus> {
  const { name, account } = program
  if (!account || 'unsupported' in account) {
    return build(name, 'unsupported', { detail: account?.unsupported ?? `${name} has no CLI-queryable account status.` })
  }
  const notInstalled = build(name, 'error', { detail: `${name} is not installed` })
  if (!findOnPath(program.command)) return notInstalled

  let output: string
  try {
    output = await runProbe(program.command, account.args)
  } catch (err) {
    if (isEnoent(err)) return notInstalled
    return build(name, 'error', { detail: `${name} probe ${err === TIMED_OUT ? 'timed out' : 'failed'}` })
  }
  try {
    return 'json' in account ? parseJson(name, output, account.json) : parseText(name, output, account.text)
  } catch {
    return build(name, 'error', { detail: `${name} probe failed` })
  }
}

/** Every configured program's account status, probed in parallel and cached for 60 s. Never rejects. */
export function getAccountStatuses(programs: AgentProgram[] = listAgentPrograms(), now: number = Date.now()): Promise<AccountStatus[]> {
  return Promise.all(programs.map(program => {
    const hit = cache.get(program.name)
    if (hit && now - hit.at < ACCOUNTS_CACHE_MS) return hit.status
    const status = probe(program).catch(() => build(program.name, 'error', { detail: `${program.name} probe failed` }))
    cache.set(program.name, { at: now, status })
    return status
  }))
}
