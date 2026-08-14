import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * lib/account-status.ts is a read-only probe over each agent CLI's own
 * status subcommand. child_process is mocked throughout — no real
 * claude/codex/gemini binary is ever invoked here.
 *
 * Every probe is routed through the Windows command processor
 * (`cmd.exe /c <bin> <args...>`, see lib/account-status.ts:runProbe) rather
 * than a bare `execFile(bin, args)`, so the mocked `execFile`'s `file`
 * argument is always the command processor, never the bin name directly.
 * Handlers below identify which CLI is being probed by inspecting `args`
 * (`args[0] === '/c'`, `args[1]` is the bin) via the `binOf` helper, and the
 * regression test further down asserts that shape explicitly.
 */

type ExecFileCallback = (error: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void

interface ExecCall {
  file: string
  args: string[]
}

let execCalls: ExecCall[]

/** The bin name a `cmd.exe /c <bin> <args...>` call is targeting. */
function binOf(args: string[]): string | undefined {
  return args[0] === '/c' ? args[1] : undefined
}

/**
 * Mock `child_process` and register a handler that decides, per call, what
 * the probed CLI "returns" — either output text or an error to hand to the
 * callback (e.g. an ENOENT-shaped error for "not installed").
 */
function mockChildProcess(
  handler: (file: string, args: string[]) => { stdout?: string; stderr?: string; error?: NodeJS.ErrnoException },
): void {
  vi.doMock('child_process', () => ({
    execFile: vi.fn((file: string, args: string[], _options: unknown, callback: ExecFileCallback) => {
      execCalls.push({ file, args })
      const result = handler(file, args)
      // stdout and stderr are handed over independently of the error, because
      // that is what really happens: `codex login status` writes to stderr,
      // and a CLI can answer usefully while still exiting non-zero.
      callback(result.error ?? null, result.stdout ?? '', result.stderr ?? '')
      return {}
    }),
  }))
}

function enoent(): NodeJS.ErrnoException {
  const err = new Error('spawn ENOENT') as NodeJS.ErrnoException
  err.code = 'ENOENT'
  return err
}

/** A non-ENOENT failure — e.g. the probed subcommand exiting non-zero. */
function execFailure(message: string): NodeJS.ErrnoException {
  return new Error(message) as NodeJS.ErrnoException
}

async function loadModule() {
  return import('../lib/account-status')
}

describe('account-status', () => {
  beforeEach(() => {
    execCalls = []
    vi.resetModules()
  })

  afterEach(() => {
    vi.doUnmock('child_process')
  })

  it('invokes every probe through the Windows command processor with a fixed argument array', async () => {
    // Regression guard: execFile('claude', args) resolves the extensionless
    // npm shim (a Unix shell script) rather than claude.cmd on Windows and
    // fails with ENOENT even when claude is genuinely installed. The probe
    // must go through cmd.exe /c so PATHEXT resolution finds the .cmd shim.
    mockChildProcess((_file, args) => {
      const bin = binOf(args)
      if (bin === 'claude') return { stdout: JSON.stringify({ loggedIn: true, email: 'user@example.com' }) }
      if (bin === 'codex') return { stdout: 'Logged in using ChatGPT' }
      return { error: enoent() }
    })

    const mod = await loadModule()
    await mod.getAccountStatuses()

    const comspec = process.env['ComSpec'] || 'cmd.exe'
    const claudeCall = execCalls.find(c => binOf(c.args) === 'claude')
    const codexCall = execCalls.find(c => binOf(c.args) === 'codex')

    expect(claudeCall).toBeDefined()
    expect(claudeCall?.file).toBe(comspec)
    expect(claudeCall?.args).toEqual(['/c', 'claude', 'auth', 'status', '--json'])

    expect(codexCall).toBeDefined()
    expect(codexCall?.file).toBe(comspec)
    expect(codexCall?.args).toEqual(['/c', 'codex', 'login', 'status'])

    // No probe ever invokes the bare binary name as `file`.
    expect(execCalls.some(c => c.file === 'claude' || c.file === 'codex')).toBe(false)
  })

  it('parses claude signed-in JSON into account/plan', async () => {
    mockChildProcess((_file, args) => {
      if (binOf(args) === 'claude') {
        return { stdout: JSON.stringify({ loggedIn: true, account: 'user@example.com', plan: 'Max' }) }
      }
      return { error: enoent() }
    })

    const mod = await loadModule()
    const statuses = await mod.getAccountStatuses()
    const claude = statuses.find(s => s.program === 'claude')

    expect(claude).toEqual({
      program: 'claude',
      state: 'signed-in',
      account: 'user@example.com',
      plan: 'Max',
    })
  })

  it('parses claude signed-out JSON', async () => {
    mockChildProcess((_file, args) => {
      if (binOf(args) === 'claude') return { stdout: JSON.stringify({ loggedIn: false }) }
      return { error: enoent() }
    })

    const mod = await loadModule()
    const statuses = await mod.getAccountStatuses()
    const claude = statuses.find(s => s.program === 'claude')

    expect(claude?.state).toBe('signed-out')
    expect(claude?.account).toBeUndefined()
  })

  it('parses the real terse codex login status output into signed-in with no plan', async () => {
    // Verified real output on a signed-in machine is exactly this one line —
    // no email, no plan, no parenthetical. codex doctor --json is not probed
    // at all: it carries no identity and performs live network checks, so it
    // is not used even as a fallback.
    mockChildProcess((_file, args) => {
      const bin = binOf(args)
      if (bin === 'codex' && args[2] === 'login' && args[3] === 'status') {
        return { stdout: 'Logged in using ChatGPT' }
      }
      return { error: enoent() }
    })

    const mod = await loadModule()
    const statuses = await mod.getAccountStatuses()
    const codex = statuses.find(s => s.program === 'codex')

    expect(codex).toEqual({
      program: 'codex',
      state: 'signed-in',
      account: 'ChatGPT',
    })
    expect(codex?.plan).toBeUndefined()
    expect(execCalls.some(c => binOf(c.args) === 'codex' && c.args[2] === 'doctor')).toBe(false)
  })

  it('parses codex login status "Not logged in" as signed-out', async () => {
    mockChildProcess((_file, args) => {
      if (binOf(args) === 'codex') return { stdout: 'Not logged in' }
      return { error: enoent() }
    })

    const mod = await loadModule()
    const statuses = await mod.getAccountStatuses()
    const codex = statuses.find(s => s.program === 'codex')

    expect(codex?.state).toBe('signed-out')
  })

  it('is tolerant of a future, more detailed codex login line but does not fabricate one today', async () => {
    mockChildProcess((_file, args) => {
      if (binOf(args) === 'codex') {
        return { stdout: 'Logged in using ChatGPT account dev@example.com (Plus plan)' }
      }
      return { error: enoent() }
    })

    const mod = await loadModule()
    const statuses = await mod.getAccountStatuses()
    const codex = statuses.find(s => s.program === 'codex')

    expect(codex).toEqual({
      program: 'codex',
      state: 'signed-in',
      account: 'dev@example.com',
      plan: 'Plus plan',
    })
  })

  it('reads codex login status from stderr when stdout is empty', async () => {
    // Regression guard, verified live: `codex login status` writes its single
    // status line to stderr and leaves stdout empty. Reading stdout alone gave
    // the parser an empty string, so a signed-in account was reported as
    // state 'error' with detail 'empty codex login status output'.
    mockChildProcess((_file, args) => {
      if (binOf(args) === 'codex') return { stdout: '', stderr: 'Logged in using ChatGPT\n' }
      return { error: enoent() }
    })

    const mod = await loadModule()
    const statuses = await mod.getAccountStatuses()
    const codex = statuses.find(s => s.program === 'codex')

    expect(codex).toEqual({ program: 'codex', state: 'signed-in', account: 'ChatGPT' })
  })

  it('trusts a usable answer on stderr even when the CLI exits non-zero', async () => {
    // "Not logged in" is a real answer, not a probe failure — a CLI that
    // reports it and exits 1 must still resolve to signed-out.
    mockChildProcess((_file, args) => {
      if (binOf(args) === 'codex') {
        return { stdout: '', stderr: 'Not logged in\n', error: execFailure('Command failed: exit code 1') }
      }
      return { error: enoent() }
    })

    const mod = await loadModule()
    const statuses = await mod.getAccountStatuses()
    const codex = statuses.find(s => s.program === 'codex')

    expect(codex?.state).toBe('signed-out')
  })

  it('treats cmd.exe\'s "is not recognized" as not-installed, not as CLI output', async () => {
    // With the cmd.exe /c wrapper a missing bin surfaces as cmd's own message
    // on stderr plus a non-zero exit, never as ENOENT. Since stderr is now
    // read, that message must not be fed to the parser as if it were output.
    mockChildProcess((_file, args) => {
      if (binOf(args) === 'codex') {
        return {
          stdout: '',
          stderr: "'codex' is not recognized as an internal or external command,\noperable program or batch file.\n",
          error: execFailure('Command failed: exit code 1'),
        }
      }
      return { error: enoent() }
    })

    const mod = await loadModule()
    const statuses = await mod.getAccountStatuses()
    const codex = statuses.find(s => s.program === 'codex')

    expect(codex?.state).toBe('error')
    expect(codex?.detail).toBe('codex is not installed')
  })

  it('reports gemini, aider, and opencode as unsupported with a non-empty detail', async () => {
    mockChildProcess(() => ({ error: enoent() }))

    const mod = await loadModule()
    const statuses = await mod.getAccountStatuses()

    for (const program of ['gemini', 'aider', 'opencode']) {
      const status = statuses.find(s => s.program === program)
      expect(status?.state).toBe('unsupported')
      expect(status?.detail).toBeTruthy()
    }

    // gemini's detail must be honest, not a file-existence guess.
    const gemini = statuses.find(s => s.program === 'gemini')
    expect(gemini?.detail).toMatch(/auth/i)

    // Nothing was ever shelled out to for these three programs.
    expect(execCalls.some(c => binOf(c.args) === 'gemini')).toBe(false)
    expect(execCalls.some(c => binOf(c.args) === 'aider')).toBe(false)
    expect(execCalls.some(c => binOf(c.args) === 'opencode')).toBe(false)
  })

  it('reports state: error (not a throw) when a CLI is not installed (ENOENT)', async () => {
    mockChildProcess(() => ({ error: enoent() }))

    const mod = await loadModule()
    const statuses = await mod.getAccountStatuses()
    const claude = statuses.find(s => s.program === 'claude')
    const codex = statuses.find(s => s.program === 'codex')

    expect(claude?.state).toBe('error')
    expect(claude?.detail).toBeTruthy()
    expect(codex?.state).toBe('error')
    expect(codex?.detail).toBeTruthy()
  })

  it('reports state: error (not a throw) when the CLI runs but exits non-zero', async () => {
    // With the cmd.exe /c wrapper, a genuinely-missing binary surfaces as
    // cmd.exe exiting non-zero (not necessarily ENOENT) — that path must
    // still resolve to state 'error', never a throw.
    mockChildProcess(() => ({ error: execFailure('Command failed: exit code 1') }))

    const mod = await loadModule()
    const statuses = await mod.getAccountStatuses()
    const claude = statuses.find(s => s.program === 'claude')
    const codex = statuses.find(s => s.program === 'codex')

    expect(claude?.state).toBe('error')
    expect(claude?.detail).toBeTruthy()
    expect(codex?.state).toBe('error')
    expect(codex?.detail).toBeTruthy()
  })

  it('never lets an unrecognized field (e.g. an access token) escape the allowlist', async () => {
    const secretToken = 'sk-super-secret-access-token-xyz'
    mockChildProcess((_file, args) => {
      const bin = binOf(args)
      if (bin === 'claude') {
        return {
          stdout: JSON.stringify({
            loggedIn: true,
            account: 'user@example.com',
            plan: 'Max',
            accessToken: secretToken,
            refreshToken: 'also-secret',
            raw: { nested: secretToken },
          }),
        }
      }
      if (bin === 'codex') {
        // codex's probe is plain-text, not JSON, so the "allowlist" is the
        // set of regex capture groups in parseCodexLoginStatus — prove a
        // trailing credential-shaped fragment on the line never leaks
        // through even though it's plain text, not a filterable JSON field.
        return { stdout: `Logged in using ChatGPT account dev@example.com (Plus plan) session_token=${secretToken}` }
      }
      return { error: enoent() }
    })

    const mod = await loadModule()
    const statuses = await mod.getAccountStatuses()
    const serialized = JSON.stringify(statuses)

    expect(serialized).not.toContain(secretToken)
    expect(serialized).not.toContain('also-secret')
    // Sanity: the allowlisted fields did make it through.
    expect(serialized).toContain('user@example.com')
    expect(serialized).toContain('dev@example.com')
  })

  it('caches results and does not re-invoke execFile within the TTL', async () => {
    let claudeCallCount = 0
    mockChildProcess((_file, args) => {
      if (binOf(args) === 'claude') {
        claudeCallCount++
        return { stdout: JSON.stringify({ loggedIn: true, account: 'user@example.com', plan: 'Max' }) }
      }
      return { error: enoent() }
    })

    const mod = await loadModule()
    await mod.getAccountStatuses()
    await mod.getAccountStatuses()
    await mod.getAccountStatuses()

    expect(claudeCallCount).toBe(1)
  })

  it('clearAccountStatusCache() resets the cache so the next call re-probes', async () => {
    let claudeCallCount = 0
    mockChildProcess((_file, args) => {
      if (binOf(args) === 'claude') {
        claudeCallCount++
        return { stdout: JSON.stringify({ loggedIn: true, account: 'user@example.com', plan: 'Max' }) }
      }
      return { error: enoent() }
    })

    const mod = await loadModule()
    await mod.getAccountStatuses()
    mod.clearAccountStatusCache()
    await mod.getAccountStatuses()

    expect(claudeCallCount).toBe(2)
  })

  it('never shells out via a shell (execFile called with argument arrays, no shell option)', async () => {
    mockChildProcess((_file, args) => {
      if (binOf(args) === 'claude') return { stdout: JSON.stringify({ loggedIn: true }) }
      return { error: enoent() }
    })

    const mod = await loadModule()
    await mod.getAccountStatuses()

    for (const call of execCalls) {
      expect(Array.isArray(call.args)).toBe(true)
    }
  })
})
