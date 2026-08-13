/**
 * Collab Path Resolver — Shared path contract for multi-collab isolation.
 * All runtime files live under the configured runtime root.
 */

import path from 'path'
import fs from 'fs'
import os from 'os'

const RUNTIME_ROOT = process.env.ENSEMBLE_RUNTIME_DIR || path.join(os.tmpdir(), 'ensemble')

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const runtimeRootVariants = [
  RUNTIME_ROOT,
  RUNTIME_ROOT.replace(/\\/g, '/'),
  RUNTIME_ROOT.replace(/\//g, '\\'),
]
const RUNTIME_ROOT_RE = new RegExp(
  [...new Set(runtimeRootVariants)].map(escapeRegExp).join('|'),
  'gi',
)

/** Remove the resolved runtime root from text shown to users. */
export function scrubCollabRuntimePaths(value: string): string {
  return value.replace(RUNTIME_ROOT_RE, '')
}

/** Base runtime directory for a team */
export function collabRuntimeDir(teamId: string): string {
  return path.join(RUNTIME_ROOT, teamId)
}

/** JSONL message log */
export function collabMessagesFile(teamId: string): string {
  return path.join(RUNTIME_ROOT, teamId, 'messages.jsonl')
}

/** Summary text written on disband */
export function collabSummaryFile(teamId: string): string {
  return path.join(RUNTIME_ROOT, teamId, 'summary.txt')
}

/** Bridge process PID file */
export function collabBridgePid(teamId: string): string {
  return path.join(RUNTIME_ROOT, teamId, 'bridge.pid')
}

/** Bridge log file */
export function collabBridgeLog(teamId: string): string {
  return path.join(RUNTIME_ROOT, teamId, 'bridge.log')
}

/** Poller process PID file */
export function collabPollerPid(teamId: string): string {
  return path.join(RUNTIME_ROOT, teamId, 'poller.pid')
}

/** Live feed output file */
export function collabFeedFile(teamId: string): string {
  return path.join(RUNTIME_ROOT, teamId, 'feed.txt')
}

/** Per-agent prompt file */
export function collabPromptFile(teamId: string, agentName: string): string {
  return path.join(RUNTIME_ROOT, teamId, 'prompts', `${agentName}.txt`)
}

/** Per-session delivery file */
export function collabDeliveryFile(teamId: string, sessionName: string): string {
  return path.join(RUNTIME_ROOT, teamId, 'delivery', `${sessionName}.txt`)
}

/** Bridge result file (raw bridge output) */
export function collabBridgeResult(teamId: string): string {
  return path.join(RUNTIME_ROOT, teamId, 'bridge-result')
}

/** Bridge posted marker */
export function collabBridgePosted(teamId: string): string {
  return path.join(RUNTIME_ROOT, teamId, 'bridge-posted')
}

/** Team ID marker file */
export function collabTeamIdFile(teamId: string): string {
  return path.join(RUNTIME_ROOT, teamId, 'team-id')
}

/** Finished marker (written on disband, signals cleanup) */
export function collabFinishedMarker(teamId: string): string {
  return path.join(RUNTIME_ROOT, teamId, '.finished')
}

/** Ensure the runtime directory (and subdirs) exist */
export function ensureCollabDirs(teamId: string): void {
  const base = collabRuntimeDir(teamId)
  fs.mkdirSync(base, { recursive: true })
  fs.mkdirSync(path.join(base, 'prompts'), { recursive: true })
  fs.mkdirSync(path.join(base, 'delivery'), { recursive: true })
}
