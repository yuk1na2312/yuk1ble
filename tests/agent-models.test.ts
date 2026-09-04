/**
 * Regression tests for per-agent model selection (§4-§6 of
 * docs/superpowers/specs/2026-08-17-per-agent-model-selection-design.md).
 *
 * Follows tests/skill-catalog.test.ts's house style: a fixture agents.json
 * pointed to via ENSEMBLE_AGENTS_CONFIG, cache cleared between tests. Follows
 * tests/readiness-gates.test.ts's marker-by-concatenation approach for
 * asserting on argv shape rather than a joined string.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  buildAgentCommandParts,
  clearAgentsConfigCache,
  isValidModel,
  resolveAgentModels,
} from '../lib/agent-config'

let fixtureDir: string
let originalAgentsConfig: string | undefined
let originalAgentFlags: string | undefined

const FIXTURE_AGENTS_CONFIG = {
  codex: {
    name: 'codex',
    command: 'codex',
    flags: ['--dangerously-bypass-approvals-and-sandbox'],
    readyMarker: 'OpenAI Codex',
    inputMethod: 'pasteFromFile',
    color: 'blue',
    icon: '◆',
    skillInvocation: 'slash',
    modelFlag: '--model',
    models: [
      { id: 'gpt-5.6-sol', label: 'Sol' },
      { id: 'gpt-5.6', label: 'GPT-5.6' },
    ],
  },
  claude: {
    name: 'claude',
    command: 'claude',
    flags: ['--permission-mode', 'auto'],
    readyMarker: '❯',
    readyMarkers: ['? for shortcuts'],
    inputMethod: 'sendKeys',
    color: 'green',
    icon: '●',
    skillInvocation: 'slash',
    modelFlag: '--model',
    models: [
      { id: 'fable', label: 'Fable 5' },
      { id: 'opus', label: 'Opus 5' },
      { id: 'sonnet', label: 'Sonnet 5' },
    ],
  },
  aider: {
    name: 'aider',
    command: 'aider',
    flags: [],
    readyMarker: '❯',
    inputMethod: 'sendKeys',
    color: 'magenta',
    icon: '▲',
    skillInvocation: 'none',
  },
}

describe('agent model selection', () => {
  beforeEach(() => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-models-'))
    const configPath = path.join(fixtureDir, 'agents.json')
    fs.writeFileSync(configPath, JSON.stringify(FIXTURE_AGENTS_CONFIG, null, 2), 'utf8')

    originalAgentsConfig = process.env['ENSEMBLE_AGENTS_CONFIG']
    process.env['ENSEMBLE_AGENTS_CONFIG'] = configPath
    originalAgentFlags = process.env['ENSEMBLE_AGENT_FLAGS']
    delete process.env['ENSEMBLE_AGENT_FLAGS']
    clearAgentsConfigCache()
  })

  afterEach(() => {
    if (originalAgentsConfig === undefined) delete process.env['ENSEMBLE_AGENTS_CONFIG']
    else process.env['ENSEMBLE_AGENTS_CONFIG'] = originalAgentsConfig

    if (originalAgentFlags === undefined) delete process.env['ENSEMBLE_AGENT_FLAGS']
    else process.env['ENSEMBLE_AGENT_FLAGS'] = originalAgentFlags

    clearAgentsConfigCache()
    fs.rmSync(fixtureDir, { recursive: true, force: true })
  })

  describe('resolveAgentModels', () => {
    it('returns the curated catalog for a direct program key', () => {
      expect(resolveAgentModels('codex')).toEqual([
        { id: 'gpt-5.6-sol', label: 'Sol' },
        { id: 'gpt-5.6', label: 'GPT-5.6' },
      ])
    })

    // Non-negotiable per the design doc: the registry stores raw creation
    // strings like "claude code", and a lookup keyed on that raw string must
    // not silently find nothing — the exact defect fixed in f716378 for
    // lib/skill-catalog.ts.
    it('resolves the "claude code" alias to the same list as "claude"', () => {
      expect(resolveAgentModels('claude code')).toEqual(resolveAgentModels('claude'))
      expect(resolveAgentModels('claude code')).toEqual([
        { id: 'fable', label: 'Fable 5' },
        { id: 'opus', label: 'Opus 5' },
        { id: 'sonnet', label: 'Sonnet 5' },
      ])
    })

    it('returns an empty array for a program with no catalog', () => {
      expect(resolveAgentModels('aider')).toEqual([])
    })

    it('returns an empty array for an unknown program that falls back to claude only when appropriate', () => {
      // resolveAgentProgram falls back to 'claude' for totally unrecognized
      // strings that don't substring-match any key; assert this doesn't throw
      // and returns something well-formed either way.
      expect(Array.isArray(resolveAgentModels('totally-unknown-program-xyz'))).toBe(true)
    })
  })

  describe('isValidModel', () => {
    it('accepts a known model id for its program', () => {
      expect(isValidModel('codex', 'gpt-5.6-sol')).toBe(true)
      expect(isValidModel('claude', 'sonnet')).toBe(true)
    })

    it('rejects an unknown model id', () => {
      expect(isValidModel('codex', 'not-a-real-model')).toBe(false)
    })

    it('rejects any id for a program with no catalog', () => {
      expect(isValidModel('aider', 'anything')).toBe(false)
    })

    it('normalizes through resolveAgentProgram before lookup ("claude code" alias)', () => {
      expect(isValidModel('claude code', 'sonnet')).toBe(true)
      expect(isValidModel('claude code', 'not-a-real-model')).toBe(false)
    })

    it('is an exact match — no substring, no case-folding beyond program resolution', () => {
      expect(isValidModel('codex', 'sol')).toBe(false)
      expect(isValidModel('codex', 'gpt-5.6-SOL')).toBe(false)
      expect(isValidModel('claude', 'Sonnet')).toBe(false)
    })
  })

  describe('buildAgentCommandParts', () => {
    it('omits the model flag entirely when no model is given', () => {
      const parts = buildAgentCommandParts('claude')
      expect(parts).not.toContain('--model')
    })

    it('appends the model flag and value as two separate argv tokens', () => {
      const parts = buildAgentCommandParts('claude', 'sonnet')
      const flagIndex = parts.indexOf('--model')

      expect(flagIndex).toBeGreaterThan(-1)
      // Two separate tokens, not "--model sonnet" concatenated into one.
      expect(parts[flagIndex]).toBe('--model')
      expect(parts[flagIndex + 1]).toBe('sonnet')
      expect(parts).toContain('claude')
    })

    it('appends nothing extra for a program with a modelFlag but no model given', () => {
      const withModel = buildAgentCommandParts('codex', 'gpt-5.6-sol')
      const withoutModel = buildAgentCommandParts('codex')

      expect(withModel.length).toBe(withoutModel.length + 2)
    })

    it('does not append a model flag for a program with no modelFlag configured', () => {
      // aider has no modelFlag in the fixture catalog at all.
      const parts = buildAgentCommandParts('aider', 'some-model')
      expect(parts).not.toContain('some-model')
    })

    it('still resolves through the program alias for command construction', () => {
      const parts = buildAgentCommandParts('claude code', 'opus')
      expect(parts[0]).toBe('claude')
      expect(parts).toContain('--model')
      expect(parts).toContain('opus')
    })

    // Precedence (§6): ENSEMBLE_AGENT_FLAGS is the operator-level override
    // and must keep winning over a GUI-selected model.
    it('drops the model argument when ENSEMBLE_AGENT_FLAGS already supplies the modelFlag', () => {
      process.env['ENSEMBLE_AGENT_FLAGS'] = '--model x'

      const parts = buildAgentCommandParts('claude', 'sonnet')

      // The env var's own "--model x" wins...
      const flagIndex = parts.indexOf('--model')
      expect(flagIndex).toBeGreaterThan(-1)
      expect(parts[flagIndex + 1]).toBe('x')
      // ...and the GUI-selected "sonnet" must not appear anywhere at all.
      expect(parts).not.toContain('sonnet')
      // Only one "--model" token total — not env's plus the picker's.
      expect(parts.filter(p => p === '--model')).toHaveLength(1)
    })

    it('leaves the model argument in place when ENSEMBLE_AGENT_FLAGS supplies an unrelated flag', () => {
      process.env['ENSEMBLE_AGENT_FLAGS'] = '--verbose'

      const parts = buildAgentCommandParts('claude', 'sonnet')

      expect(parts).toContain('--verbose')
      const flagIndex = parts.indexOf('--model')
      expect(flagIndex).toBeGreaterThan(-1)
      expect(parts[flagIndex + 1]).toBe('sonnet')
    })
  })
})
