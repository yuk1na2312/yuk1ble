/**
 * Agent adapters — loads and validates agents.json and provides lookups.
 * Single source of truth for everything specific to one agent CLI.
 *
 * Validation happens once, at load, so a bad config fails at server start with a
 * message naming the program and the key, not at the first spawn.
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import type { AgentGate, AgentModel, AgentProgram, AgentsConfig, AgentUsagePattern } from '../types/agent-program'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export class AgentConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AgentConfigError'
  }
}

/** A program name that matches no entry (or alias) in agents.json. */
export class UnknownProgramError extends Error {
  constructor(readonly program: string, readonly available: string[]) {
    super(`unknown program "${program}"; available: ${available.join(', ')}`)
    this.name = 'UnknownProgramError'
  }
}

// ─── Validation ─────────────────────────────────────────────────────────────

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/** Compile a regex source (case-insensitive, as every adapter pattern is used). */
function compile(source: string, where: string): RegExp {
  try {
    return new RegExp(source, 'i')
  } catch (err) {
    throw new AgentConfigError(`${where}: invalid regex ${JSON.stringify(source)} (${err instanceof Error ? err.message : err})`)
  }
}

function captureGroups(source: string): number {
  // Matching `source|` against '' succeeds with every group undefined, so the length gives the group count.
  return (new RegExp(`${source}|`).exec('')?.length ?? 1) - 1
}

function stringArray(value: unknown, where: string, options: { nonEmpty?: boolean } = {}): string[] {
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) {
    throw new AgentConfigError(`${where}: must be an array of strings`)
  }
  if (value.some(item => !item.trim())) throw new AgentConfigError(`${where}: must not contain a blank entry`)
  if (options.nonEmpty && value.length === 0) throw new AgentConfigError(`${where}: must not be empty`)
  return value
}

function optionalFlag(entry: Record<string, unknown>, key: string, where: string): string | undefined {
  const value = entry[key]
  if (value === undefined) return undefined
  if (!nonBlank(value) || !value.startsWith('-')) throw new AgentConfigError(`${where}: "${key}" must be a flag starting with "-"`)
  return value
}

function parseGate(raw: unknown, where: string): AgentGate {
  if (!isRecord(raw)) throw new AgentConfigError(`${where}: must be an object`)
  if (!nonBlank(raw.name)) throw new AgentConfigError(`${where}: "name" is required`)
  if (!nonBlank(raw.pattern)) throw new AgentConfigError(`${where}: "pattern" is required`)
  compile(raw.pattern, `${where}.pattern`)
  const gate: AgentGate = {
    name: raw.name,
    pattern: raw.pattern,
    keys: stringArray(raw.keys, `${where}.keys`, { nonEmpty: true }),
  }
  if (raw.trustKeys !== undefined) gate.trustKeys = stringArray(raw.trustKeys, `${where}.trustKeys`, { nonEmpty: true })
  if (raw.trustEnv !== undefined) {
    if (!nonBlank(raw.trustEnv)) throw new AgentConfigError(`${where}.trustEnv: must be a non-blank string`)
    gate.trustEnv = raw.trustEnv
  }
  if ((gate.trustKeys === undefined) !== (gate.trustEnv === undefined)) {
    throw new AgentConfigError(`${where}: "trustKeys" and "trustEnv" go together`)
  }
  for (const key of ['literal', 'enter'] as const) {
    if (raw[key] === undefined) continue
    if (typeof raw[key] !== 'boolean') throw new AgentConfigError(`${where}.${key}: must be true or false`)
    gate[key] = raw[key]
  }
  return gate
}

function parseUsagePattern(raw: unknown, where: string): AgentUsagePattern {
  if (!isRecord(raw) || !nonBlank(raw.pattern) || !nonBlank(raw.format)) {
    throw new AgentConfigError(`${where}: must be { "pattern": "...", "format": "...$1..." }`)
  }
  compile(raw.pattern, `${where}.pattern`)
  if (captureGroups(raw.pattern) !== 1) throw new AgentConfigError(`${where}.pattern: must have exactly one capture group`)
  if (!raw.format.includes('$1')) throw new AgentConfigError(`${where}.format: must contain $1`)
  return { pattern: raw.pattern, format: raw.format }
}

function parseModel(raw: unknown, where: string): AgentModel {
  if (!isRecord(raw) || !nonBlank(raw.id) || !nonBlank(raw.label)) {
    throw new AgentConfigError(`${where}: must be { "id": "...", "label": "..." }`)
  }
  return { id: raw.id, label: raw.label }
}

function parseProgram(name: string, raw: unknown): AgentProgram {
  const at = `program "${name}"`
  if (!isRecord(raw)) throw new AgentConfigError(`${at}: must be an object`)

  if (!nonBlank(raw.command)) throw new AgentConfigError(`${at}: "command" is required (non-blank string)`)
  if (raw.inputMethod !== 'pasteFromFile' && raw.inputMethod !== 'sendKeys') {
    throw new AgentConfigError(`${at}: "inputMethod" must be "pasteFromFile" or "sendKeys"`)
  }
  if (!nonBlank(raw.color) || !HEX_COLOR.test(raw.color)) {
    throw new AgentConfigError(`${at}: "color" must be a hex colour like "#6aa9ff"`)
  }
  if (!nonBlank(raw.icon)) throw new AgentConfigError(`${at}: "icon" is required (non-blank string)`)

  // The old single `readyMarker` is still accepted so existing user configs load.
  const markerSources = [raw.readyMarker, ...(raw.readyMarkers === undefined ? [] : [raw.readyMarkers])]
  const readyMarkers: string[] = []
  for (const source of markerSources) {
    if (source === undefined) continue
    readyMarkers.push(...(typeof source === 'string' ? [source] : stringArray(source, `${at}: "readyMarkers"`)))
  }
  if (readyMarkers.some(marker => !marker.trim())) {
    throw new AgentConfigError(`${at}: "readyMarkers" must not contain a blank marker (it would match every screen)`)
  }
  if (readyMarkers.length === 0) throw new AgentConfigError(`${at}: "readyMarkers" is required (at least one marker)`)

  const program: AgentProgram = {
    name,
    command: raw.command,
    flags: raw.flags === undefined ? [] : stringArray(raw.flags, `${at}: "flags"`),
    readyMarkers: [...new Set(readyMarkers)],
    inputMethod: raw.inputMethod,
    color: raw.color,
    icon: raw.icon,
  }

  const cwdFlag = optionalFlag(raw, 'cwdFlag', at)
  if (cwdFlag) program.cwdFlag = cwdFlag
  if (raw.cwdFlagAliases !== undefined) program.cwdFlagAliases = stringArray(raw.cwdFlagAliases, `${at}: "cwdFlagAliases"`)
  const addDirFlag = optionalFlag(raw, 'addDirFlag', at)
  if (addDirFlag) program.addDirFlag = addDirFlag

  if (raw.pasteMarker !== undefined) {
    if (!nonBlank(raw.pasteMarker)) throw new AgentConfigError(`${at}: "pasteMarker" must be a non-blank regex source`)
    compile(raw.pasteMarker, `${at}: "pasteMarker"`)
    program.pasteMarker = raw.pasteMarker
  }

  if (raw.gates !== undefined) {
    if (!Array.isArray(raw.gates)) throw new AgentConfigError(`${at}: "gates" must be an array`)
    program.gates = raw.gates.map((gate, i) => parseGate(gate, `${at}: gates[${i}]`))
  }
  if (raw.usagePatterns !== undefined) {
    if (!Array.isArray(raw.usagePatterns)) throw new AgentConfigError(`${at}: "usagePatterns" must be an array`)
    program.usagePatterns = raw.usagePatterns.map((p, i) => parseUsagePattern(p, `${at}: usagePatterns[${i}]`))
  }
  if (raw.stripEnv !== undefined) {
    program.stripEnv = stringArray(raw.stripEnv, `${at}: "stripEnv"`)
    program.stripEnv.forEach((source, i) => compile(source, `${at}: stripEnv[${i}]`))
  }

  const modelFlag = optionalFlag(raw, 'modelFlag', at)
  if (modelFlag) program.modelFlag = modelFlag
  if (raw.models !== undefined) {
    if (!Array.isArray(raw.models)) throw new AgentConfigError(`${at}: "models" must be an array`)
    program.models = raw.models.map((m, i) => parseModel(m, `${at}: models[${i}]`))
    const ids = program.models.map(m => m.id)
    if (new Set(ids).size !== ids.length) throw new AgentConfigError(`${at}: "models" has a duplicate id`)
    if (program.models.length > 0 && !program.modelFlag) {
      throw new AgentConfigError(`${at}: "models" needs a "modelFlag" to pass the chosen model`)
    }
  }

  if (raw.skillInvocation !== undefined) {
    if (!nonBlank(raw.skillInvocation)) throw new AgentConfigError(`${at}: "skillInvocation" must be a non-blank string`)
    program.skillInvocation = raw.skillInvocation
  }
  return program
}

/** Validate a parsed agents.json. Throws AgentConfigError naming the program and key. */
export function parseAgentsConfig(raw: unknown): AgentsConfig {
  if (!isRecord(raw)) throw new AgentConfigError('agents config must be a JSON object keyed by program name')
  const config: AgentsConfig = {}
  for (const [name, entry] of Object.entries(raw)) config[name.toLowerCase()] = parseProgram(name.toLowerCase(), entry)
  if (Object.keys(config).length === 0) throw new AgentConfigError('agents config defines no programs')
  return config
}

// ─── Loading and lookup ─────────────────────────────────────────────────────

let _cache: AgentsConfig | null = null

/** Load agents.json from the repo root, or ENSEMBLE_AGENTS_CONFIG (validated, cached after first read). */
export function loadAgentsConfig(): AgentsConfig {
  if (_cache) return _cache

  const configPath = process.env['ENSEMBLE_AGENTS_CONFIG']
    || path.join(__dirname, '..', 'agents.json')

  let raw: unknown
  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf-8').replace(/^\uFEFF/, ''))
  } catch (err) {
    throw new AgentConfigError(`${configPath}: cannot read agents config (${err instanceof Error ? err.message : err})`)
  }
  try {
    _cache = parseAgentsConfig(raw)
  } catch (err) {
    throw new AgentConfigError(`${configPath}: ${err instanceof Error ? err.message : err}`)
  }
  return _cache
}

/** Clear cached config (useful for tests) */
export function clearAgentsConfigCache(): void {
  _cache = null
}

/** Every configured program, in agents.json order. */
export function listAgentPrograms(): AgentProgram[] {
  return Object.values(loadAgentsConfig())
}

/**
 * Resolve a program string to its adapter, or undefined when nothing matches.
 * Matches the key exactly, or as a leading word so that "claude code" and
 * "claude-code" resolve to "claude". There is deliberately no fallback to a
 * default program: guessing would spawn the wrong CLI.
 */
export function resolveAgentProgram(program: string): AgentProgram | undefined {
  const config = loadAgentsConfig()
  const p = program.trim().toLowerCase()
  if (config[p]) return config[p]

  const keys = Object.keys(config).sort((a, b) => b.length - a.length)
  const key = keys.find(candidate => p.startsWith(candidate) && /^[\s_-]/.test(p.slice(candidate.length)))
  return key ? config[key] : undefined
}

/** Like resolveAgentProgram, but throws UnknownProgramError. */
export function requireAgentProgram(program: string): AgentProgram {
  const agent = resolveAgentProgram(program)
  if (!agent) throw new UnknownProgramError(program, Object.keys(loadAgentsConfig()))
  return agent
}

/** Names of every configured program, for error messages. */
export function listProgramNames(): string[] {
  return Object.keys(loadAgentsConfig())
}

/** All strings that mean "this agent is at its input prompt". Any one is sufficient. */
export function resolveReadyMarkers(program: string): string[] {
  return requireAgentProgram(program).readyMarkers
}

/**
 * Build the full CLI command for an agent as an array of unescaped tokens.
 *
 * Tokens are deliberately left unescaped: callers either hand them straight to
 * execFile/spawn, or quote them for a specific shell themselves (see
 * `toPowerShellCommandLine` in lib/agent-spawner.ts).
 */
export function buildAgentCommandParts(program: string): string[] {
  const agent = requireAgentProgram(program)
  const envFlags = (process.env['ENSEMBLE_AGENT_FLAGS'] ?? '').trim()

  const envTokens = envFlags ? envFlags.split(/\s+/).filter(Boolean) : []
  const envFlagKeys = new Set(envTokens.filter(token => token.startsWith('-')))
  const defaultTokens: string[] = []

  for (let i = 0; i < agent.flags.length; i++) {
    const token = agent.flags[i]
    if (!token.startsWith('-')) {
      defaultTokens.push(token)
      continue
    }
    if (envFlagKeys.has(token)) {
      if (i + 1 < agent.flags.length && !agent.flags[i + 1].startsWith('-')) i++
      continue
    }
    defaultTokens.push(token)
    if (i + 1 < agent.flags.length && !agent.flags[i + 1].startsWith('-')) {
      defaultTokens.push(agent.flags[++i])
    }
  }

  return [agent.command, ...envTokens, ...defaultTokens]
}
