import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clearAgentsConfigCache } from '../lib/agent-config'
import {
  resolveStartCommand,
  shellEscape,
  toPowerShellCommandLine,
} from '../lib/agent-spawner'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Ask PowerShell whether each line parses, without running any of it.
 *
 * `Parser::ParseInput` is the same parser the shell uses at the prompt, so this
 * catches the exact failure the `&` call operator exists to prevent — a
 * statement beginning with a quoted string is parsed in *expression* mode.
 * Nothing is executed, so no agent CLI is ever launched.
 */
const parseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-psparse-'))

function powerShellParseErrors(lines: string[]): (string | null)[] {
  const inputFile = path.join(parseDir, 'input.txt')
  const scriptFile = path.join(parseDir, 'parse.ps1')

  // One line per command; \n is not valid inside any command we generate.
  fs.writeFileSync(inputFile, lines.join('\n'), 'utf8')
  fs.writeFileSync(
    scriptFile,
    [
      '$ErrorActionPreference = "Stop"',
      `$lines = [System.IO.File]::ReadAllLines(${shellEscape(inputFile)})`,
      'foreach ($line in $lines) {',
      '  $errs = $null',
      '  [void][System.Management.Automation.Language.Parser]::ParseInput($line, [ref]$null, [ref]$errs)',
      '  if ($errs.Count -gt 0) { Write-Output ("ERR " + $errs[0].Message) } else { Write-Output "OK" }',
      '}',
    ].join('\r\n'),
    'utf8',
  )

  const stdout = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptFile],
    { encoding: 'utf8', timeout: 60_000 },
  )

  return stdout
    .split(/\r?\n/)
    .filter(line => line.length > 0)
    .map(line => (line === 'OK' ? null : line.replace(/^ERR /, '')))
}

const describeOnWindows = process.platform === 'win32' ? describe : describe.skip

describe('resolveStartCommand', () => {
  const originalAgentFlags = process.env.ENSEMBLE_AGENT_FLAGS

  beforeEach(() => {
    delete process.env.ENSEMBLE_AGENT_FLAGS
    clearAgentsConfigCache()
  })

  afterEach(() => {
    if (originalAgentFlags === undefined) {
      delete process.env.ENSEMBLE_AGENT_FLAGS
    } else {
      process.env.ENSEMBLE_AGENT_FLAGS = originalAgentFlags
    }
    clearAgentsConfigCache()
  })

  it('invokes the program through the & call operator', () => {
    // Regression guard for P0-1. The previous implementation returned
    // `parts.map(shellEscape).join(' ')` — i.e. `'claude' '--permission-mode' 'auto'`
    // — which PowerShell parses in expression mode and rejects, so no agent
    // could ever launch.
    const command = resolveStartCommand('claude', path.join('C:', 'work', 'repo'))

    expect(command.startsWith('& ')).toBe(true)
    expect(command).toContain("'claude'")
    expect(command).not.toMatch(/^'/)
  })

  it('quotes every token, including the program name', () => {
    const command = resolveStartCommand('claude', path.join('C:', 'work', 'repo'))
    expect(command).toContain("'--permission-mode' 'auto'")
  })

  it('passes a working directory containing spaces through as a single token', () => {
    const cwd = 'C:\\Users\\khoin\\My Projects\\x'
    const command = resolveStartCommand('codex', cwd)

    expect(command).toContain(`'--cd' '${cwd}'`)
  })

  it('drops a redundant trailing separator from directory arguments', () => {
    // PowerShell double-quotes whitespace-bearing arguments when handing them to
    // a native .exe; a trailing backslash then escapes the closing quote and the
    // child receives `C:\My Projects"`.
    const command = resolveStartCommand('codex', 'C:\\Users\\khoin\\My Projects\\')

    expect(command).toContain("'--cd' 'C:\\Users\\khoin\\My Projects'")
    expect(command).not.toContain("My Projects\\'")
  })

  it('keeps the separator on a filesystem root, where it is not redundant', () => {
    // `E:` alone means "current directory on E:", not the root of E:.
    const command = resolveStartCommand('codex', 'E:\\')

    expect(command).toContain("'--cd' 'E:\\'")
  })

  it('adds --add-dir for claude when running outside the repo root', () => {
    const command = resolveStartCommand('claude', path.join('C:', 'work', 'elsewhere'))
    expect(command).toContain(`'--add-dir' '${REPO_ROOT}'`)
  })

  it('omits --add-dir for claude when already at the repo root', () => {
    const command = resolveStartCommand('claude', REPO_ROOT)
    expect(command).not.toContain('--add-dir')
  })
})

describe('shellEscape', () => {
  it('doubles embedded single quotes', () => {
    expect(shellEscape("it's a test")).toBe("'it''s a test'")
  })

  it('leaves backslashes, $ and backticks untouched inside single quotes', () => {
    expect(shellEscape('C:\\a\\b')).toBe("'C:\\a\\b'")
    expect(shellEscape('$env:PATH `x $(1+1)')).toBe("'$env:PATH `x $(1+1)'")
  })
})

describe('toPowerShellCommandLine', () => {
  it('returns an empty string for no parts rather than a bare call operator', () => {
    expect(toPowerShellCommandLine([])).toBe('')
  })

  it('prefixes a single-token command with the call operator', () => {
    expect(toPowerShellCommandLine(['claude'])).toBe("& 'claude'")
  })
})

describeOnWindows('PowerShell parse validation', () => {
  afterAll(() => {
    fs.rmSync(parseDir, { recursive: true, force: true })
  })

  it('accepts commands produced by resolveStartCommand and rejects the pre-fix form', () => {
    const fixed = [
      resolveStartCommand('claude', 'C:\\Users\\khoin\\My Projects\\x'),
      resolveStartCommand('codex', 'C:\\Users\\khoin\\My Projects\\x'),
      resolveStartCommand('gemini', 'C:\\work\\repo'),
      toPowerShellCommandLine(['node', 'C:\\a b\\s.js', "--msg", "it's a test"]),
    ]
    // Exactly what the old `parts.map(shellEscape).join(' ')` produced.
    const preFix = "'claude' '--permission-mode' 'auto'"

    const results = powerShellParseErrors([...fixed, preFix])

    for (let i = 0; i < fixed.length; i++) {
      expect(results[i], `should parse: ${fixed[i]}`).toBeNull()
    }

    // Proves the check discriminates: the old form is a genuine parse error.
    expect(results[fixed.length]).toContain('--permission-mode')
  })
})
