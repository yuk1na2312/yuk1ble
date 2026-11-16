/**
 * Agent Spawner — Standalone agent lifecycle management for Ensemble
 * Replaces ai-maestro's agent-registry + agents-core-service with a minimal implementation.
 * Handles: runtime session creation, program launching, and session cleanup.
 */

import { v4 as uuidv4 } from 'uuid'
import path from 'path'
import { fileURLToPath } from 'url'
import { getRuntime } from './agent-runtime'
import { buildAgentCommandParts } from './agent-config'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')

export interface SpawnedAgent {
  id: string
  name: string
  program: string
  sessionName: string
  workingDirectory: string
}

interface SpawnAgentOptions {
  name: string
  program: string
  workingDirectory: string
}

/** Compute a runtime session name from an agent name. */
function computeSessionName(agentName: string): string {
  return agentName.replace(/[^a-zA-Z0-9\-_.]/g, '')
}

/**
 * Quote a single token as a PowerShell single-quoted literal.
 *
 * Single quotes make PowerShell treat the contents verbatim — no `$var`
 * interpolation, no backtick escapes, no `;`/`|` statement separation — so the
 * only character needing escaping is `'` itself, which is doubled.
 */
export function shellEscape(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/**
 * Normalize a directory argument so it survives being passed to a native `.exe`.
 *
 * A trailing backslash is the one path shape that PowerShell cannot pass
 * through intact. When an argument contains whitespace, PowerShell wraps it in
 * double quotes on the Win32 command line, and the trailing `\` then escapes
 * that closing quote — `C:\My Projects\` arrives at the child process as
 * `C:\My Projects"`. (Verified live on Windows PowerShell 5.1; `.ps1` shims,
 * which receive PowerShell strings rather than a re-parsed command line, are
 * unaffected — so the corruption depends on how the agent CLI happens to be
 * installed.) Dropping the redundant trailing separator sidesteps it entirely
 * and is equivalent for every consumer. Filesystem roots such as `E:\` keep
 * their separator: `E:` alone means "the current directory on E:", not the
 * root — and having no whitespace, they are never quoted anyway.
 */
function normalizeDirArg(dir: string): string {
  if (!dir) return dir
  const normalized = path.normalize(dir)
  if (normalized === path.parse(normalized).root) return normalized
  return normalized.replace(/[\\/]+$/, '')
}

/**
 * Join tokens into a runnable PowerShell command line.
 *
 * PowerShell parses a statement that begins with a quoted string in
 * *expression* mode, so `'claude' '--permission-mode' 'auto'` is a parse error
 * ("Unexpected token '--permission-mode' in expression or statement") and the
 * program never launches. The call operator `&` forces command mode, which also
 * handles executable paths containing spaces.
 */
export function toPowerShellCommandLine(parts: string[]): string {
  if (parts.length === 0) return ''
  return `& ${parts.map(shellEscape).join(' ')}`
}

/** Resolve program name to a PowerShell-runnable CLI command, adding runtime flags for cwd handling */
export function resolveStartCommand(program: string, cwd: string): string {
  const parts = buildAgentCommandParts(program)
  const normalized = program.toLowerCase()

  if (
    normalized.includes('codex')
    && !parts.some(p => p === '-C' || p === '--cd' || p.startsWith('--cd='))
  ) {
    parts.push('--cd', normalizeDirArg(cwd))
  }

  if (
    normalized.includes('claude')
    && cwd !== REPO_ROOT
    && !parts.some(p => p === '--add-dir' || p.startsWith('--add-dir='))
  ) {
    parts.push('--add-dir', normalizeDirArg(REPO_ROOT))
  }

  return toPowerShellCommandLine(parts)
}

/**
 * Spawn a local agent in a runtime session and start the AI program.
 */
export async function spawnLocalAgent(options: SpawnAgentOptions): Promise<SpawnedAgent> {
  const runtime = getRuntime()
  const agentId = uuidv4()
  const sessionName = computeSessionName(options.name)
  const cwd = options.workingDirectory || process.cwd()

  // Create the runtime session.
  await runtime.createSession(sessionName, cwd)

  // Small delay for session init
  await new Promise(r => setTimeout(r, 300))

  // Start the AI program
  const startCommand = resolveStartCommand(options.program, cwd)

  await runtime.sendKeys(sessionName, startCommand, { literal: true, enter: true })

  console.log(`[Spawner] Agent ${options.name} started in runtime session ${sessionName}`)

  return {
    id: agentId,
    name: options.name,
    program: options.program,
    sessionName,
    workingDirectory: cwd,
  }
}

/**
 * Gracefully stop a local agent, then guarantee runtime-session cleanup.
 */
export async function killLocalAgent(sessionName: string): Promise<void> {
  const runtime = getRuntime()
  try {
    // Try graceful exit first
    await runtime.sendKeys(sessionName, 'C-c', { enter: false })
    await new Promise(r => setTimeout(r, 200))
    await runtime.sendKeys(sessionName, 'exit', { literal: true, enter: true })
    await new Promise(r => setTimeout(r, 200))
    await runtime.killSession(sessionName)
  } catch {
    // Session may already be gone
    try { await runtime.killSession(sessionName) } catch { /* ok */ }
  }
}

/**
 * Scrape token usage from an agent session's output.
 * Best-effort: returns 'unknown' if parsing fails.
 *
 * Claude Code patterns: "NNk tokens", "NN,NNN tokens", "NNN tokens"
 * Codex patterns: "NN% left", "NNk tokens"
 */
export async function getAgentTokenUsage(sessionName: string): Promise<string> {
  try {
    const runtime = getRuntime()
    const output = await runtime.capturePane(sessionName, 100)

    // Claude Code: "123k tokens" or "12,345 tokens" or "1.2k tokens"
    const claudeKMatch = output.match(/(\d+(?:\.\d+)?k)\s*tokens/i)
    if (claudeKMatch) return `~${claudeKMatch[1]} tokens`

    const claudeFullMatch = output.match(/([\d,]+)\s*tokens/i)
    if (claudeFullMatch) return `~${claudeFullMatch[1]} tokens`

    // Codex: "NN% left"
    const codexPctMatch = output.match(/(\d+)%\s*left/i)
    if (codexPctMatch) return `${codexPctMatch[1]}% budget left`

    return 'unknown'
  } catch {
    return 'unknown'
  }
}
