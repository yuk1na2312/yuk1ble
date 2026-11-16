/**
 * Windows process helpers shared by the runtime, the spawner and the service.
 * One copy of the tree-kill and PowerShell quoting logic.
 */

import { execFile, execFileSync } from 'child_process'

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
