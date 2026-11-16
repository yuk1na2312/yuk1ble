/**
 * Windows process helpers shared by the runtime, the spawner and the service.
 * One copy of the tree-kill and PowerShell quoting logic.
 */

import { execFile, execFileSync } from 'child_process'
import { existsSync } from 'fs'
import { delimiter, join } from 'path'

/**
 * Quote a single token as a PowerShell single-quoted literal.
 *
 * Single quotes make PowerShell treat the contents verbatim — no `$var`
 * interpolation, no backtick escapes, no `;`/`|` statement separation — so the
 * only character needing escaping is `'` itself, which is doubled.
 */
export function quotePowerShell(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/** Kill a process and all of its descendants. Never rejects. */
export function killProcessTree(pid: number): Promise<void> {
  return new Promise(resolve => {
    execFile('taskkill', ['/T', '/F', '/PID', String(pid)], () => resolve())
  })
}

/** Synchronous variant for `exit` handlers. Never throws. */
export function killProcessTreeSync(pid: number): void {
  try {
    execFileSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore' })
  } catch {
    // The process tree may already have exited.
  }
}

function executableNames(command: string): string[] {
  if (/\.[^\\/]+$/.test(command)) return [command]

  const extensions = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .filter(Boolean)
  return [command, ...extensions.map(extension => `${command}${extension.toLowerCase()}`)]
}

/** First place `command` is found on PATH (trying every PATHEXT extension), if any. */
export function findOnPath(command: string): string | undefined {
  const pathValue = process.env.PATH || process.env.Path
  if (!pathValue) return undefined

  const names = executableNames(command)
  for (const directory of pathValue
    .split(delimiter)
    .filter(Boolean)
    .map(directory => directory.replace(/^"|"$/g, ''))) {
    for (const name of names) {
      const candidate = join(directory, name)
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}
