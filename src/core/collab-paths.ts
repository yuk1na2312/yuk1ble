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

/** Legacy transcript of teams from before the in-memory store; read once when a feed loads, never written. */
export function collabMessagesFile(teamId: string): string {
  return path.join(RUNTIME_ROOT, teamId, 'messages.jsonl')
}

/** Summary text written on disband */
export function collabSummaryFile(teamId: string): string {
  return path.join(RUNTIME_ROOT, teamId, 'summary.txt')
}

/** Per-agent prompt file */
export function collabPromptFile(teamId: string, agentName: string): string {
  return path.join(RUNTIME_ROOT, teamId, 'prompts', `${agentName}.txt`)
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
}
