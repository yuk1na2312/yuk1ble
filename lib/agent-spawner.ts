/**
 * Agent Spawner — Standalone agent lifecycle management for Ensemble
 * Replaces ai-maestro's agent-registry + agents-core-service with a minimal implementation.
 * Handles: runtime session creation, program launching, and session cleanup.
 */

import { randomUUID } from 'crypto'
import path from 'path'
import { fileURLToPath } from 'url'
import { getRuntime } from './agent-runtime'
import { buildAgentCommandParts, requireAgentProgram, resolveAgentProgram } from './agent-config'
import { quotePowerShell } from './win-process'

// Kept under its old name for existing callers and tests.
export { quotePowerShell as shellEscape }

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
  /** A catalog model id; absent means no model flag. */
  model?: string
}

/** Compute a runtime session name from an agent name. */
function computeSessionName(agentName: string): string {
  return agentName.replace(/[^a-zA-Z0-9\-_.]/g, '')
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
  return `& ${parts.map(quotePowerShell).join(' ')}`
}

/** True when the command line already has `flag`, as `flag value` or `flag=value`. */
function hasFlag(parts: string[], flags: string[]): boolean {
  return parts.some(part => flags.some(flag => part === flag || part.startsWith(`${flag}=`)))
}

/**
 * Resolve a program name to a PowerShell-runnable CLI command. The adapter says
 * which flags carry the working directory and the repo root; nothing here knows
 * a program by name.
 */
export function resolveStartCommand(program: string, cwd: string, model?: string): string {
  const agent = requireAgentProgram(program)
  const parts = buildAgentCommandParts(program, model)

  if (agent.cwdFlag && !hasFlag(parts, [agent.cwdFlag, ...(agent.cwdFlagAliases ?? [])])) {
    parts.push(agent.cwdFlag, normalizeDirArg(cwd))
  }

  if (agent.addDirFlag && cwd !== REPO_ROOT && !hasFlag(parts, [agent.addDirFlag])) {
    parts.push(agent.addDirFlag, normalizeDirArg(REPO_ROOT))
  }

  return toPowerShellCommandLine(parts)
}

/**
 * Spawn a local agent in a runtime session and start the AI program.
 */
export async function spawnLocalAgent(options: SpawnAgentOptions): Promise<SpawnedAgent> {
  const runtime = getRuntime()
  const agentId = randomUUID()
  const sessionName = computeSessionName(options.name)
  const cwd = options.workingDirectory || process.cwd()

  // Create the runtime session.
  await runtime.createSession(sessionName, cwd)

  // Small delay for session init
  await new Promise(r => setTimeout(r, 300))

  // Start the AI program
  const startCommand = resolveStartCommand(options.program, cwd, options.model)

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
 * Scrape token usage from an agent session's output, using the adapter's
 * usagePatterns (tried in order; the first match wins).
 * Best-effort: returns 'unknown' if nothing matches or the session is gone.
 */
export async function getAgentTokenUsage(sessionName: string, program: string): Promise<string> {
  try {
    const patterns = resolveAgentProgram(program)?.usagePatterns ?? []
    if (patterns.length === 0) return 'unknown'
    const output = await getRuntime().capturePane(sessionName, 100)

    for (const { pattern, format } of patterns) {
      const match = output.match(new RegExp(pattern, 'i'))
      if (match) return format.replace(/\$1/g, () => match[1])
    }
    return 'unknown'
  } catch {
    return 'unknown'
  }
}
