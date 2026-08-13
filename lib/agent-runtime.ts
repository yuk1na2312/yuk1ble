/**
 * Agent runtime abstraction.
 *
 * Native Windows uses the node-pty-backed direct runtime exclusively.
 */

import {
  killSessionSync as killPtySessionSync,
  PtyRuntime,
  renameSessionSync as renamePtySessionSync,
  sessionExistsSync as ptySessionExistsSync,
} from './pty-runtime'

export interface DiscoveredSession {
  name: string
  windows: number
  createdAt: string
  workingDirectory: string
}

export interface AgentRuntime {
  readonly type: 'tmux' | 'happy' | 'docker' | 'api' | 'direct'

  // Discovery
  listSessions(): Promise<DiscoveredSession[]>

  // Existence / status
  sessionExists(name: string): Promise<boolean>
  getWorkingDirectory(name: string): Promise<string>
  isInCopyMode(name: string): Promise<boolean>
  cancelCopyMode(name: string): Promise<void>

  // Lifecycle
  createSession(name: string, cwd: string): Promise<void>
  killSession(name: string): Promise<void>
  renameSession(oldName: string, newName: string): Promise<void>

  // I/O
  sendKeys(name: string, keys: string, opts?: { literal?: boolean; enter?: boolean }): Promise<void>
  pasteFromFile(name: string, filePath: string): Promise<void>
  capturePane(name: string, lines?: number): Promise<string>

  // Environment
  setEnvironment(name: string, key: string, value: string): Promise<void>
  unsetEnvironment(name: string, key: string): Promise<void>

  // PTY
  getAttachCommand(name: string, socketPath?: string): { command: string; args: string[] }
}

let defaultRuntime: AgentRuntime = new PtyRuntime()

export function getRuntime(): AgentRuntime {
  return defaultRuntime
}

export function setRuntime(runtime: AgentRuntime): void {
  defaultRuntime = runtime
}

export function sessionExistsSync(name: string, socketPath?: string): boolean {
  return ptySessionExistsSync(name, socketPath)
}

export function killSessionSync(name: string): void {
  killPtySessionSync(name)
}

export function renameSessionSync(oldName: string, newName: string): void {
  renamePtySessionSync(oldName, newName)
}
