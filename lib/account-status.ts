/**
 * Account Status Probe — read-only check of which account each agent CLI is
 * signed in as, for the accounts tab in the monitoring GUI.
 *
 * SECURITY: this module is strictly read-only. It never signs in, signs out,
 * or writes credentials, and it never reads credential files directly — it
 * only shells out to each CLI's own status subcommand. CLI output may carry
 * tokens or other credential material, so every result is rebuilt from a
 * fixed field allowlist (`buildStatus` below) before it leaves this module.
 * Raw stdout and any unrecognized field are discarded — never logged, never
 * written to disk, never passed through to the caller.
 */

import { execFile } from 'child_process'

const PROBE_TIMEOUT_MS = 5000
const CACHE_TTL_MS = 60_000

export type AccountState = 'signed-in' | 'signed-out' | 'unsupported' | 'error'

export interface AccountStatus {
  program: string
  state: AccountState
  /** Identity label, e.g. an email or account name. */
  account?: string
  /** Plan label, e.g. "Max", "ChatGPT Plus". */
  plan?: string
  /** Human-readable explanation, used for unsupported/error states. */
  detail?: string
}

/** The fixed, known set of agent programs. Keeps the probe list explicit. */
const PROGRAMS = ['claude', 'codex', 'gemini', 'aider', 'opencode'] as const
type Program = (typeof PROGRAMS)[number]

interface CacheEntry {
  status: AccountStatus
  expiresAt: number
}

/**
 * Keyed by program name. `PROGRAMS` above is a fixed, five-entry list, so
 * this map can never grow past five entries — it is bounded by construction
 * and needs no separate eviction policy beyond the TTL check in `fromCache`.
 */
const cache = new Map<string, CacheEntry>()

/** Clear the cache. Exists for tests; not exposed over HTTP. */
export function clearAccountStatusCache(): void {
  cache.clear()
}

function fromCache(program: string): AccountStatus | undefined {
  const entry = cache.get(program)
  if (!entry) return undefined
  if (Date.now() >= entry.expiresAt) {
    cache.delete(program)
    return undefined
  }
  return entry.status
}

function toCache(program: string, status: AccountStatus): void {
  cache.set(program, { status, expiresAt: Date.now() + CACHE_TTL_MS })
}

/**
 * Run a CLI probe and collect its output without using `util.promisify` —
 * a plain callback-to-Promise wrapper here, rather than relying on
 * `child_process.execFile`'s built-in `promisify.custom` behavior, keeps
 * this module trivially mockable: tests replace `execFile` with a plain
 * `vi.fn()` that invokes its callback, same idiom as the rest of this repo
 * (see tests/bridge-lifecycle.test.ts).
 *
 * Invoked through the Windows command processor (`cmd.exe /c <bin> <args>`)
 * rather than `execFile(bin, args)` directly. Reason, verified live: on
 * Windows, npm installs each agent CLI as a PATH pair — an extensionless
 * shim (a Unix shell script, not something Windows can execute) plus a
 * sibling `<bin>.cmd`, the real Windows entry point. `execFile` resolves
 * executables itself and does not apply `PATHEXT` the way a shell does, so
 * `execFile('claude', args)` finds the extensionless shim, fails to run it,
 * and surfaces ENOENT even though claude is genuinely installed and
 * working — misreporting a working install as "not installed". Routing
 * through `cmd.exe /c` makes the command processor do the same `PATHEXT`
 * resolution a user's shell would, landing on `claude.cmd`.
 *
 * This is NOT a shell-interpolation risk and NOT a violation of AGENTS.md's
 * "never use cmd.exe": `shell` stays off; `/c`, `bin`, and every arg are
 * separate elements of the array handed to `execFile`, never a concatenated
 * string, so there is nothing for `cmd.exe` to re-parse or interpolate —
 * every element here is a hardcoded constant from this module's own probe
 * list, never user input. And the AGENTS.md rule is scoped to
 * `ENSEMBLE_SHELL`, the interactive PTY shell used to run spawned agent
 * sessions — it does not govern a one-shot, non-interactive status probe
 * like this one. Do not "simplify" this back to a bare `execFile(bin, args)`.
 *
 * Output stream, verified live: these CLIs do not agree on one.
 * `claude auth status --json` writes its JSON to stdout, but
 * `codex login status` writes its single status line to **stderr** and leaves
 * stdout empty. Reading stdout alone therefore handed the codex parser an
 * empty string and misreported a signed-in account as an error. So stderr is
 * used as the fallback whenever stdout is blank. Exit code is treated the
 * same way: a CLI that answers "Not logged in" and exits non-zero has still
 * answered, so a non-zero exit only fails the probe when nothing usable came
 * back with it.
 */

/** cmd.exe's own message when the bin isn't on PATH — not CLI output. */
const NOT_RECOGNIZED = /is not recognized as an internal or external command/i

function runProbe(bin: string, args: string[]): Promise<string> {
  const comspec = process.env['ComSpec'] || 'cmd.exe'
  return new Promise((resolve, reject) => {
    execFile(
      comspec,
      ['/c', bin, ...args],
      { timeout: PROBE_TIMEOUT_MS, windowsHide: true },
      (error, stdout, stderr) => {
        const text = stdout && stdout.trim() ? stdout : (stderr || '')

        if (NOT_RECOGNIZED.test(text)) {
          // cmd.exe couldn't find the bin. Normalize to ENOENT so this reports
          // as "not installed" rather than as unparseable CLI output.
          const missing = new Error(`${bin} is not on PATH`) as NodeJS.ErrnoException
          missing.code = 'ENOENT'
          reject(missing)
          return
        }

        if (error && !text.trim()) {
          reject(error)
          return
        }
        resolve(text)
      },
    )
  })
}

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT'
}

/** Build a status from only the allowlisted fields — never forward raw input. */
function buildStatus(
  program: string,
  state: AccountState,
  fields: { account?: string; plan?: string; detail?: string } = {},
): AccountStatus {
  const status: AccountStatus = { program, state }
  if (fields.account && fields.account.trim()) status.account = fields.account.trim()
  if (fields.plan && fields.plan.trim()) status.plan = fields.plan.trim()
  if (fields.detail && fields.detail.trim()) status.detail = fields.detail.trim()
  return status
}

function unsupported(program: string, detail: string): AccountStatus {
  return buildStatus(program, 'unsupported', { detail })
}

function errorStatus(program: string, err: unknown): AccountStatus {
  if (isEnoent(err)) return buildStatus(program, 'error', { detail: `${program} is not installed` })
  return buildStatus(program, 'error', { detail: `${program} probe failed` })
}

/**
 * Read the first string field found among `keys` on `obj`. Only these named
 * keys are ever inspected — this is the allowlist boundary for parsed JSON;
 * any other field on `obj` (e.g. a token) is never looked at, let alone
 * returned.
 */
function firstString(obj: unknown, keys: string[]): string | undefined {
  if (!obj || typeof obj !== 'object') return undefined
  const record = obj as Record<string, unknown>
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return undefined
}

function firstBoolean(obj: unknown, keys: string[]): boolean | undefined {
  if (!obj || typeof obj !== 'object') return undefined
  const record = obj as Record<string, unknown>
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'boolean') return value
  }
  return undefined
}

/**
 * Parse `claude auth status --json`.
 *
 * Verified real shape:
 *   { loggedIn: boolean, authMethod: string, apiProvider: string,
 *     email: string, orgId: string, orgName: string, subscriptionType: string }
 * `email` and `subscriptionType` are the primary account/plan fields; the
 * alternates after them are kept as fallbacks for older/other CLI builds.
 * `authMethod`/`apiProvider`/`orgId`/`orgName` are intentionally never read —
 * they are not in the allowlist, so they can never reach the caller even if
 * present in the raw JSON.
 */
function parseClaudeAuthStatus(raw: string): AccountStatus {
  const parsed: unknown = JSON.parse(raw)
  const signedIn = firstBoolean(parsed, ['loggedIn', 'authenticated', 'signedIn', 'isAuthenticated'])
  const account = firstString(parsed, ['email', 'account', 'user', 'username'])
  const plan = firstString(parsed, ['subscriptionType', 'plan', 'subscription', 'tier'])

  if (signedIn === false) return buildStatus('claude', 'signed-out')
  if (signedIn === true || account) return buildStatus('claude', 'signed-in', { account, plan })
  throw new Error('unrecognized claude auth status output')
}

/**
 * Parse `codex login status` — the sole codex probe.
 *
 * `codex doctor --json` was tried first and rejected: verified real output
 * carries no account identity anywhere (auth health lives at
 * `checks["auth.credentials"]` as `{ id, category, status, summary, details,
 * remediation, durationMs }`, where `details` is only a diagnostic string
 * like "stored ChatGPT tokens" — never an email or account name), and it
 * performs live network checks (DNS resolution, a websocket handshake,
 * provider reachability) that make it slow and unfit for a cached probe
 * behind a 5s timeout. Do not resurrect it as the primary probe.
 *
 * Verified real `codex login status` output is a single terse line with no
 * email and no plan, e.g.:
 *   "Logged in using ChatGPT"
 *   "Not logged in"
 * Parsing stays tolerant of a future, more detailed line such as
 * "Logged in using ChatGPT account user@example.com (Plus plan)" — an email
 * or a parenthetical plan is extracted when present, but their absence
 * (today's reality) is normal, not an error.
 */
function parseCodexLoginStatus(raw: string): AccountStatus {
  const text = raw.trim()
  if (!text) return buildStatus('codex', 'error', { detail: 'empty codex login status output' })
  if (/not logged in/i.test(text)) return buildStatus('codex', 'signed-out')

  if (/logged in/i.test(text)) {
    const emailMatch = /([\w.+-]+@[\w-]+\.[\w.-]+)/.exec(text)
    const planMatch = /\(([^)]+)\)/.exec(text)
    const usingMatch = /logged in using\s+([^(\n]+?)(?:\s+account\b|\s*$)/i.exec(text)

    return buildStatus('codex', 'signed-in', {
      account: emailMatch?.[1] ?? usingMatch?.[1]?.trim(),
      plan: planMatch?.[1],
    })
  }
  return buildStatus('codex', 'error', { detail: 'unrecognized codex login status output' })
}

async function probeClaude(): Promise<AccountStatus> {
  try {
    const output = await runProbe('claude', ['auth', 'status', '--json'])
    return parseClaudeAuthStatus(output)
  } catch (err) {
    return errorStatus('claude', err)
  }
}

async function probeCodex(): Promise<AccountStatus> {
  try {
    // Note: this output arrives on stderr, not stdout — see runProbe.
    const output = await runProbe('codex', ['login', 'status'])
    return parseCodexLoginStatus(output)
  } catch (err) {
    return errorStatus('codex', err)
  }
}

async function probeProgram(program: Program): Promise<AccountStatus> {
  switch (program) {
    case 'claude':
      return probeClaude()
    case 'codex':
      return probeCodex()
    case 'gemini':
      // No `gemini auth` subcommand exists on this CLI — sign-in happens via
      // `/auth` inside the interactive TUI. A file-existence heuristic was
      // considered and rejected: `~/.gemini/oauth_creds.json` is absent even
      // on a working install when the key lives in Windows Credential
      // Manager instead, so the heuristic would report a false "signed out".
      return unsupported('gemini', 'No CLI-queryable auth status — sign in via /auth inside the interactive gemini TUI.')
    case 'aider':
      return unsupported('aider', 'aider has no CLI-queryable account status.')
    case 'opencode':
      return unsupported('opencode', 'opencode has no CLI-queryable account status.')
  }
}

/** Get (or serve from cache) the account status for one program. */
async function getAccountStatus(program: Program): Promise<AccountStatus> {
  const cached = fromCache(program)
  if (cached) return cached

  const status = await probeProgram(program)
  toCache(program, status)
  return status
}

/**
 * Report which account each known agent CLI is signed in as. Read-only:
 * runs each program's own status subcommand, never touches credential files,
 * and never performs a login/logout action.
 */
export async function getAccountStatuses(): Promise<AccountStatus[]> {
  return Promise.all(PROGRAMS.map(program => getAccountStatus(program)))
}
