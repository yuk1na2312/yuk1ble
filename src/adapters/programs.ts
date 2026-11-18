/**
 * The program catalog served to the GUI and CLI: what each adapter looks like and
 * whether its command is on PATH. The PATH scan stats the disk, so the answer is
 * cached briefly instead of being recomputed on every request.
 */

import { listAgentPrograms } from './agent-config'
import { findOnPath } from '../runtime/win-process'
import type { AgentModel } from './types'

export interface ProgramInfo {
  name: string
  icon: string
  color: string
  models: AgentModel[]
  installed: boolean
}

export const PROGRAMS_CACHE_MS = 30_000

let cached: { at: number; programs: ProgramInfo[] } | undefined

/** Clear the cache (tests; also useful after the PATH changes). */
export function clearProgramsCache(): void {
  cached = undefined
}

export function describePrograms(now: number = Date.now()): ProgramInfo[] {
  if (cached && now - cached.at < PROGRAMS_CACHE_MS) return cached.programs
  const programs = listAgentPrograms().map(program => ({
    name: program.name,
    icon: program.icon,
    color: program.color,
    models: program.models ?? [],
    installed: findOnPath(program.command) !== undefined,
  }))
  cached = { at: now, programs }
  return programs
}
