import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * parseAgentSpec() — the `--agents program:model` suffix parser for the CLI
 * (design doc §9: docs/superpowers/specs/2026-08-17-per-agent-model-selection-design.md).
 *
 * This is the ONLY place the suffix is parsed; the same shape it produces
 * ({ program, model? }) is what the GUI posts directly, and server-side
 * validation of the model against the program's catalog happens once, in
 * createEnsembleTeam — not duplicated here.
 *
 * Importing cli/ensemble.ts transitively imports lib/pty-runtime.ts, which
 * registers process.once('exit'/'SIGINT'/'SIGTERM') handlers as a module-level
 * side effect — diff and strip whatever this file's import adds, same idiom
 * as tests/static-files.test.ts and tests/team-removal.test.ts, so nothing
 * leaks into other test files sharing this worker.
 *
 * cli/ensemble.ts's command dispatch (the switch statement at the bottom of
 * the file) only runs when `isMainModule()` — comparing process.argv[1] to
 * the file's own path — is true. Under vitest, process.argv[1] is vitest's
 * own worker script, so importing this module for parseAgentSpec() never
 * executes a CLI command, never reads a real command line, and never calls
 * process.exit().
 */

const sigintBefore = process.listeners('SIGINT')
const sigtermBefore = process.listeners('SIGTERM')
const beforeExitBefore = process.listeners('beforeExit')
const exitBefore = process.listeners('exit')

let parseAgentSpec: (spec: string) => { program: string; model?: string }

beforeAll(async () => {
  const cli = await import('../cli/ensemble')
  parseAgentSpec = cli.parseAgentSpec
})

afterAll(() => {
  for (const listener of process.listeners('SIGINT')) {
    if (!sigintBefore.includes(listener)) process.removeListener('SIGINT', listener)
  }
  for (const listener of process.listeners('SIGTERM')) {
    if (!sigtermBefore.includes(listener)) process.removeListener('SIGTERM', listener)
  }
  for (const listener of process.listeners('beforeExit')) {
    if (!beforeExitBefore.includes(listener)) process.removeListener('beforeExit', listener)
  }
  for (const listener of process.listeners('exit')) {
    if (!exitBefore.includes(listener)) process.removeListener('exit', listener)
  }
})

describe('parseAgentSpec()', () => {
  // ── unsuffixed entries keep working byte-identically ────────────────

  it('parses a bare program name with no model', () => {
    expect(parseAgentSpec('codex')).toEqual({ program: 'codex' })
  })

  it('parses a bare program name containing a space, unchanged ("claude code")', () => {
    // The documented default for `ensemble run` with no --agents flag.
    expect(parseAgentSpec('claude code')).toEqual({ program: 'claude code' })
  })

  it('trims surrounding whitespace on an unsuffixed entry', () => {
    expect(parseAgentSpec('  gemini  ')).toEqual({ program: 'gemini' })
  })

  // ── suffixed entries ─────────────────────────────────────────────────

  it('parses a program:model suffix into { program, model }', () => {
    expect(parseAgentSpec('codex:gpt-5.6-sol')).toEqual({ program: 'codex', model: 'gpt-5.6-sol' })
  })

  it('parses a claude alias model suffix', () => {
    expect(parseAgentSpec('claude:sonnet')).toEqual({ program: 'claude', model: 'sonnet' })
  })

  it('trims whitespace around both the program and model side of a suffix', () => {
    expect(parseAgentSpec(' codex : gpt-5.6-sol ')).toEqual({ program: 'codex', model: 'gpt-5.6-sol' })
  })

  // ── ambiguity: split on the LAST colon ──────────────────────────────

  it('splits on the last colon, not the first', () => {
    // A hypothetical program name containing a colon still gets its trailing
    // :model suffix parsed correctly this way.
    expect(parseAgentSpec('weird:program:sonnet')).toEqual({ program: 'weird:program', model: 'sonnet' })
  })

  // ── malformed suffixes fall back to the literal, unsuffixed string ──

  it('treats a trailing bare colon as a literal program name, not a suffix split', () => {
    expect(parseAgentSpec('codex:')).toEqual({ program: 'codex:' })
  })

  it('treats a leading bare colon as a literal program name, not a suffix split', () => {
    expect(parseAgentSpec(':sonnet')).toEqual({ program: ':sonnet' })
  })

  // ── mixed --agents values (comma-split happens at the call site; this
  // proves each individual entry parses independently) ────────────────

  it('parses a mixed list of suffixed and unsuffixed entries independently', () => {
    const entries = 'codex:gpt-5.6-sol,claude,claude:sonnet'.split(',').map(parseAgentSpec)
    expect(entries).toEqual([
      { program: 'codex', model: 'gpt-5.6-sol' },
      { program: 'claude' },
      { program: 'claude', model: 'sonnet' },
    ])
  })
})
