/**
 * Agent runtime abstraction.
 *
 * Native Windows uses the node-pty-backed PtyRuntime exclusively. The interface
 * is sized to what callers use: everything that only made sense for tmux is gone.
 *
 * Only `create` and `kill` are async (they spawn and reap processes). Everything
 * else is a synchronous call into an in-process session; a missing session
 * throws from the writers and answers `false` / `''` from the readers.
 */

import { PtyRuntime } from './pty-runtime'

export interface SessionInfo {
  name: string
  createdAt: string
  workingDirectory: string
}

export interface SendKeysOptions {
  /** Send `keys` as typed text even when every space-separated token is a named key. */
  literal?: boolean
  /** Press Enter after the keys. */
  enter?: boolean
}

export interface AgentRuntime {
  // Lifecycle
  create(name: string, cwd: string): Promise<void>
  /** Kills the session's whole process tree. A session that is already gone is not an error. */
  kill(name: string): Promise<void>
  exists(name: string): boolean
  list(): SessionInfo[]

  // Input
  /** Raw bytes, exactly as given. */
  write(name: string, data: string): void
  /** Named keys ("Enter", "C-c", "Down" ...) or, with `literal`, typed text. */
  sendKeys(name: string, keys: string, opts?: SendKeysOptions): void
  /** The text, then a CR as a separate write. A paste alone never submits: see lib/paste-submit.ts. */
  paste(name: string, text: string): void
  resize(name: string, cols: number, rows: number): void

  // Output
  /** The rendered screen (not raw bytes), last `lines` lines. '' when the session is gone. */
  screen(name: string, lines?: number): string
  /** Bounded raw scrollback, for a terminal that connects mid-run. '' when the session is gone. */
  replay(name: string): string
  /** Raw PTY chunks as they arrive. Returns the unsubscribe function. Throws when the session is gone or has too many listeners. */
  onData(name: string, cb: (chunk: string) => void): () => void
  /** Called once when the session ends. Returns the unsubscribe function. */
  onExit(name: string, cb: () => void): () => void
}

let defaultRuntime: AgentRuntime = new PtyRuntime()

export function getRuntime(): AgentRuntime {
  return defaultRuntime
}

export function setRuntime(runtime: AgentRuntime): void {
  defaultRuntime = runtime
}
