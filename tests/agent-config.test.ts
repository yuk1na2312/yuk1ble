import { execFile } from 'child_process'
import fs from 'fs'
import net from 'net'
import os from 'os'
import path from 'path'
import { promisify } from 'util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AgentConfigError, UnknownProgramError, clearAgentsConfigCache, loadAgentsConfig, parseAgentsConfig,
  buildAgentCommandParts, isValidModel, requireAgentProgram, resolveAgentModels, resolveAgentProgram, resolveReadyMarkers,
} from '../lib/agent-config'
import { FIXTURE_AGENTS_CONFIG } from './helpers/boot-server'

const execFileAsync = promisify(execFile)

const base = {
  command: 'fake',
  readyMarkers: ['fake> '],
  inputMethod: 'sendKeys',
  color: '#112233',
  icon: '*',
}
const withEntry = (overrides: Record<string, unknown>) => ({ fake: { ...base, ...overrides } })

describe('agents.json as shipped', () => {
  beforeEach(() => { delete process.env.ENSEMBLE_AGENTS_CONFIG; clearAgentsConfigCache() })
  afterEach(() => clearAgentsConfigCache())

  it('validates, and every program has a hex colour, an icon and a non-blank marker', () => {
    const config = loadAgentsConfig()
    expect(Object.keys(config)).toEqual(['codex', 'claude', 'aider', 'gemini', 'opencode'])
    for (const program of Object.values(config)) {
      expect(program.color).toMatch(/^#[0-9a-f]{6}$/i)
      expect(program.icon).toBeTruthy()
      expect(program.readyMarkers.length).toBeGreaterThan(0)
      for (const marker of program.readyMarkers) expect(marker.trim()).not.toBe('')
    }
  })
})

describe('validation', () => {
  it('accepts a minimal entry and names it after its key', () => {
    const config = parseAgentsConfig(withEntry({}))
    expect(config.fake).toMatchObject({ name: 'fake', command: 'fake', flags: [], readyMarkers: ['fake> '] })
  })

  it('still accepts the old single readyMarker, merged with readyMarkers without duplicates', () => {
    const config = parseAgentsConfig(withEntry({ readyMarker: 'old> ', readyMarkers: ['new> ', 'old> '] }))
    expect(config.fake.readyMarkers).toEqual(['old> ', 'new> '])
  })

  const without = (key: keyof typeof base) => withEntry({ [key]: undefined })

  it.each<[string, unknown, string[]]>([
    ['a missing command', without('command'), ['program "fake"', '"command"']],
    ['a blank command', withEntry({ command: '  ' }), ['program "fake"', '"command"']],
    ['no ready marker at all', without('readyMarkers'), ['program "fake"', '"readyMarkers"']],
    ['an empty readyMarkers array', withEntry({ readyMarkers: [] }), ['program "fake"', '"readyMarkers"']],
    ['a blank ready marker', withEntry({ readyMarkers: ['ok', '  '] }), ['program "fake"', '"readyMarkers"', 'blank']],
    ['a bad inputMethod', withEntry({ inputMethod: 'telepathy' }), ['program "fake"', '"inputMethod"']],
    ['a missing colour', without('color'), ['program "fake"', '"color"']],
    ['a colour name instead of hex', withEntry({ color: 'blue' }), ['program "fake"', '"color"']],
    ['flags that are not strings', withEntry({ flags: ['-a', 3] }), ['program "fake"', '"flags"']],
    ['a cwdFlag that is not a flag', withEntry({ cwdFlag: 'cd' }), ['program "fake"', '"cwdFlag"']],
    ['a pasteMarker that does not compile', withEntry({ pasteMarker: '[unclosed' }), ['program "fake"', '"pasteMarker"', 'invalid regex']],
    ['a gate pattern that does not compile', withEntry({ gates: [{ name: 'g', pattern: '(', keys: ['Enter'] }] }), ['program "fake"', 'gates[0].pattern', 'invalid regex']],
    ['a gate without keys', withEntry({ gates: [{ name: 'g', pattern: 'x' }] }), ['gates[0].keys']],
    ['a gate with an empty keys array', withEntry({ gates: [{ name: 'g', pattern: 'x', keys: [] }] }), ['gates[0].keys', 'must not be empty']],
    ['trustKeys without trustEnv', withEntry({ gates: [{ name: 'g', pattern: 'x', keys: ['1'], trustKeys: ['2'] }] }), ['gates[0]', 'trustKeys']],
    ['an empty trustKeys array', withEntry({ gates: [{ name: 'g', pattern: 'x', keys: ['1'], trustKeys: [], trustEnv: 'E' }] }), ['gates[0].trustKeys']],
    ['a usage pattern with two capture groups', withEntry({ usagePatterns: [{ pattern: '(\\d)(\\d)', format: '$1' }] }), ['usagePatterns[0].pattern', 'one capture group']],
    ['a usage pattern with no capture group', withEntry({ usagePatterns: [{ pattern: '\\d+', format: '$1' }] }), ['usagePatterns[0].pattern', 'one capture group']],
    ['a usage format without $1', withEntry({ usagePatterns: [{ pattern: '(\\d+)', format: 'n' }] }), ['usagePatterns[0].format']],
    ['a stripEnv entry that does not compile', withEntry({ stripEnv: ['(('] }), ['stripEnv[0]', 'invalid regex']],
    ['models without a modelFlag', withEntry({ models: [{ id: 'a', label: 'A' }] }), ['program "fake"', '"modelFlag"']],
    ['a model without a label', withEntry({ modelFlag: '--model', models: [{ id: 'a' }] }), ['models[0]']],
    ['a duplicate model id', withEntry({ modelFlag: '--model', models: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }] }), ['duplicate id']],
  ])('rejects %s, naming the program and the key', (_label, config, fragments) => {
    let error: unknown
    try { parseAgentsConfig(config) } catch (err) { error = err }
    expect(error).toBeInstanceOf(AgentConfigError)
    for (const fragment of fragments) expect((error as Error).message).toContain(fragment)
  })

  it('rejects a config that is not an object or defines nothing', () => {
    expect(() => parseAgentsConfig([])).toThrow(AgentConfigError)
    expect(() => parseAgentsConfig({})).toThrow(/no programs/)
  })
})

describe('loading', () => {
  let dir: string
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-cfg-')); clearAgentsConfigCache() })
  afterEach(() => {
    delete process.env.ENSEMBLE_AGENTS_CONFIG
    clearAgentsConfigCache()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('names the file when the config is invalid', () => {
    const file = path.join(dir, 'agents.json')
    fs.writeFileSync(file, JSON.stringify(withEntry({ readyMarkers: ['ok', ''] })))
    process.env.ENSEMBLE_AGENTS_CONFIG = file
    expect(() => loadAgentsConfig()).toThrow(file)
    expect(() => loadAgentsConfig()).toThrow(/program "fake"/)
  })

  it('names the file when it is missing or is not JSON', () => {
    const file = path.join(dir, 'agents.json')
    process.env.ENSEMBLE_AGENTS_CONFIG = file
    expect(() => loadAgentsConfig()).toThrow(AgentConfigError)
    fs.writeFileSync(file, '{ nope')
    expect(() => loadAgentsConfig()).toThrow(file)
  })

  it('loads a file written with a byte-order mark', () => {
    const file = path.join(dir, 'agents.json')
    fs.writeFileSync(file, `\uFEFF${JSON.stringify(withEntry({}))}`)
    process.env.ENSEMBLE_AGENTS_CONFIG = file
    expect(loadAgentsConfig().fake.command).toBe('fake')
  })

  it('stops the server at start, not at the first spawn, when the config is bad', async () => {
    const file = path.join(dir, 'agents.json')
    fs.writeFileSync(file, JSON.stringify(withEntry({ readyMarkers: [] })))
    const port = await new Promise<number>((resolve, reject) => {
      const srv = net.createServer()
      srv.listen(0, '127.0.0.1', () => {
        const address = srv.address()
        srv.close(() => (address && typeof address !== 'string' ? resolve(address.port) : reject(new Error('no port'))))
      })
    })

    const tsx = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs')
    const result = await execFileAsync(process.execPath, [tsx, 'server.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ENSEMBLE_AGENTS_CONFIG: file,
        ENSEMBLE_PORT: String(port),
        ENSEMBLE_DATA_DIR: dir,
        ENSEMBLE_RUNTIME_DIR: path.join(dir, 'runtime'),
      },
      timeout: 30_000,
    }).then(() => ({ code: 0, output: '' }), (err: { code?: number; stdout?: string; stderr?: string }) => ({
      code: err.code ?? -1,
      output: `${err.stdout ?? ''}${err.stderr ?? ''}`,
    }))

    expect(result.code).toBe(1)
    expect(result.output).toContain('program "fake"')
    expect(result.output).toContain('"readyMarkers"')
  }, 40_000)
})

describe('resolving a program', () => {
  beforeEach(() => { process.env.ENSEMBLE_AGENTS_CONFIG = FIXTURE_AGENTS_CONFIG; clearAgentsConfigCache() })
  afterEach(() => { delete process.env.ENSEMBLE_AGENTS_CONFIG; clearAgentsConfigCache() })

  it.each(['claude', 'Claude', ' claude ', 'claude code', 'claude-code', 'CLAUDE_Code'])('resolves %j to claude', name => {
    expect(resolveAgentProgram(name)?.name).toBe('claude')
  })

  it('resolves a direct key before any alias', () => {
    expect(resolveAgentProgram('codex')?.name).toBe('codex')
    expect(resolveReadyMarkers('claude code')).toEqual(['>'])
  })

  it.each(['gpt', 'claudex', 'notclaude', 'claudecode', '', 'codexa b'])('does NOT resolve %j, and never falls back to claude', name => {
    expect(resolveAgentProgram(name)).toBeUndefined()
  })

  it('requireAgentProgram throws a typed error listing what is available', () => {
    let error: unknown
    try { requireAgentProgram('gpt') } catch (err) { error = err }
    expect(error).toBeInstanceOf(UnknownProgramError)
    expect((error as UnknownProgramError).message).toBe('unknown program "gpt"; available: codex, claude, plain')
    expect(() => resolveReadyMarkers('gpt')).toThrow(UnknownProgramError)
  })
})

describe('models', () => {
  beforeEach(() => {
    process.env.ENSEMBLE_AGENTS_CONFIG = FIXTURE_AGENTS_CONFIG
    delete process.env.ENSEMBLE_AGENT_FLAGS
    clearAgentsConfigCache()
  })
  afterEach(() => { delete process.env.ENSEMBLE_AGENTS_CONFIG; delete process.env.ENSEMBLE_AGENT_FLAGS; clearAgentsConfigCache() })

  it('lists the catalog of a program, through its aliases', () => {
    expect(resolveAgentModels('claude code').map(m => m.id)).toEqual(['fable', 'opus', 'sonnet'])
    expect(resolveAgentModels('codex')).toEqual([{ id: 'gpt-5.6-sol', label: 'Sol' }])
    expect(resolveAgentModels('plain')).toEqual([])
    expect(resolveAgentModels('nonsense')).toEqual([])
  })

  it('accepts only ids in the catalog of that very program', () => {
    expect(isValidModel('claude code', 'sonnet')).toBe(true)
    expect(isValidModel('codex', 'gpt-5.6-sol')).toBe(true)
    expect(isValidModel('codex', 'sonnet')).toBe(false)
    expect(isValidModel('claude', 'haiku')).toBe(false)
    expect(isValidModel('claude', 'Sonnet')).toBe(false)
    expect(isValidModel('plain', 'anything')).toBe(false)
  })

  it('appends the model as two separate argv tokens, and nothing when there is none', () => {
    expect(buildAgentCommandParts('claude', 'sonnet')).toEqual(['claude', '--permission-mode', 'auto', '--model', 'sonnet'])
    expect(buildAgentCommandParts('claude')).toEqual(['claude', '--permission-mode', 'auto'])
    expect(buildAgentCommandParts('codex', 'gpt-5.6-sol')).toEqual([
      'codex', '--dangerously-bypass-approvals-and-sandbox', '--model', 'gpt-5.6-sol',
    ])
  })

  it('passes no flag for a program that has no modelFlag', () => {
    expect(buildAgentCommandParts('plain', 'whatever')).toEqual(['plain'])
  })

  it('lets an ENSEMBLE_AGENT_FLAGS --model win over the picker', () => {
    process.env.ENSEMBLE_AGENT_FLAGS = '--model opus'
    expect(buildAgentCommandParts('claude', 'sonnet')).toEqual(['claude', '--model', 'opus', '--permission-mode', 'auto'])
    process.env.ENSEMBLE_AGENT_FLAGS = '--model=opus'
    expect(buildAgentCommandParts('claude', 'sonnet')).not.toContain('sonnet')
  })
})

describe('the shipped model catalog', () => {
  beforeEach(() => { delete process.env.ENSEMBLE_AGENTS_CONFIG; clearAgentsConfigCache() })
  afterEach(() => clearAgentsConfigCache())

  it('holds only the verified ids', () => {
    expect(resolveAgentModels('codex').map(m => m.id)).toEqual(['gpt-5.6-sol'])
    expect(resolveAgentModels('claude').map(m => m.id)).toEqual(['fable', 'opus', 'sonnet'])
    for (const name of ['aider', 'gemini', 'opencode']) expect(resolveAgentModels(name)).toEqual([])
  })
})
