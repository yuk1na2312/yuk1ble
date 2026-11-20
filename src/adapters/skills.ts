/**
 * Skill catalog: the skills installed for an agent CLI, behind GET /api/ensemble/skills and the
 * allowlist POST /api/ensemble/teams/:id/skill checks a token against.
 *
 * Where to look is data: the program's `skills` entry in agents.json (roots, plugin manifest).
 * Read-only: nothing here writes, installs or enables a skill.
 *
 * SECURITY: no absolute filesystem path may appear in a returned entry or catalog. The API has no
 * auth, and a path would leak the home-directory layout and the installed-plugin inventory to any
 * page that can reach loopback. Every returned string comes from a directory name, a manifest key or
 * frontmatter text, never from a path. Tokens are typed into a terminal, so only names made of
 * letters, digits, `.`, `_` and `-` are listed.
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import { resolveAgentProgram, SKILL_PLACEHOLDER } from './agent-config'
import type { AgentSkills, SkillInvocation } from './types'

export const SKILLS_CACHE_MS = 60_000
export const MAX_CACHED_CATALOGS = 64
/** This module walks user-controlled directories on every GUI open, so each limit is load-bearing. */
export const MAX_SKILLS_PER_CATALOG = 300
export const MAX_DIR_ENTRIES_PER_ROOT = 200
export const MAX_DESCRIPTION_LENGTH = 240
export const MAX_PLUGIN_ROOTS = 100
/** Frontmatter is at the top of SKILL.md; bodies can run to hundreds of KB. */
export const FRONTMATTER_READ_BYTES = 4096
const MAX_MANIFEST_BYTES = 1024 * 1024
const SAFE_NAME = /^[A-Za-z0-9][\w.-]*$/

export type SkillSource = 'project' | 'personal' | 'plugin'

export interface SkillEntry {
  /** The exact text typed after "/": "brandkit" or "superpowers:brainstorming". */
  token: string
  /** The directory name. */
  name: string
  /** Frontmatter description, cut to MAX_DESCRIPTION_LENGTH. Absent when there is none. */
  description?: string
  source: SkillSource
  /** Group heading: "project", "personal" or the plugin name. */
  group: string
}

export interface SkillCatalog {
  program: string
  invocation: SkillInvocation
  skills: SkillEntry[]
  /** Why there is no picker (`none`), or what was unreadable or cut off. */
  detail?: string
}

const cache = new Map<string, { catalog: SkillCatalog; expiresAt: number }>()

/** Clear the cache (tests). */
export function clearSkillCatalogCache(): void {
  cache.clear()
}

function remember(key: string, catalog: SkillCatalog): void {
  const now = Date.now()
  for (const [k, entry] of cache) if (entry.expiresAt <= now) cache.delete(k)
  while (cache.size >= MAX_CACHED_CATALOGS) cache.delete(cache.keys().next().value as string)
  cache.set(key, { catalog, expiresAt: now + SKILLS_CACHE_MS })
}

/** One directory searched for `<name>/SKILL.md`. `dir` never leaves this module. */
interface RootSpec {
  dir: string
  source: SkillSource
  group: string
  /** Prepended to the directory name: "" or "pluginName:". */
  tokenPrefix: string
}

/** Fill in a path template; undefined when a placeholder has no value or the result is not absolute. */
function expand(template: string, home: string, project: string | undefined): string | undefined {
  let unresolved = false
  const out = template.replace(SKILL_PLACEHOLDER, (_all: string, envName?: string, fallback?: string, name?: string) => {
    const value = envName
      ? ((process.env[envName] ?? '').trim() || expand(fallback ?? '', home, project))
      : name === 'home' ? home : project
    if (value === undefined) unresolved = true
    return value ?? ''
  })
  return unresolved || !path.isAbsolute(out) ? undefined : out
}

/** Plugin roots, one per plugin and straight from the manifest's installPath: the plugin cache holds every installed version side by side. */
function pluginRoots(manifestPath: string): RootSpec[] {
  let manifest: unknown
  try {
    if (fs.statSync(manifestPath).size > MAX_MANIFEST_BYTES) return []
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  } catch {
    return [] // no plugins installed, or an unreadable manifest
  }
  const plugins = (manifest as { plugins?: unknown } | null)?.plugins
  if (!plugins || typeof plugins !== 'object') return []

  const roots: RootSpec[] = []
  for (const [key, value] of Object.entries(plugins)) {
    if (!Array.isArray(value)) continue
    const name = key.split('@')[0]
    if (!SAFE_NAME.test(name)) continue
    const installs = (value as Array<{ scope?: unknown; installPath?: unknown }>)
      .filter(entry => typeof entry?.installPath === 'string' && path.isAbsolute(entry.installPath))
    // A project-scoped install overrides the shared user one.
    const chosen = installs.find(entry => entry.scope === 'project') ?? installs[0]
    if (!chosen) continue
    roots.push({ dir: path.join(chosen.installPath as string, 'skills'), source: 'plugin', group: name, tokenPrefix: `${name}:` })
  }
  roots.sort((a, b) => a.group.localeCompare(b.group))
  return roots.slice(0, MAX_PLUGIN_ROOTS)
}

function stripQuotes(value: string): string {
  const first = value[0]
  return value.length >= 2 && (first === '"' || first === "'") && value.endsWith(first) ? value.slice(1, -1) : value
}

/**
 * The `description` of a leading `---` block. Not YAML: SKILL.md frontmatter is `name:` and `description:`,
 * and an indented line under either continues it (joined with one space).
 */
function parseDescription(text: string): { name?: string; description?: string } {
  const lines = text.split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return {}
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === '---')
  if (end === -1) return {} // never closed within the bytes read: not trustworthy

  const fields: { name?: string; description?: string } = {}
  let current: 'name' | 'description' | null = null
  for (const line of lines.slice(1, end)) {
    const key = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (key) {
      current = key[1] === 'name' || key[1] === 'description' ? key[1] : null
      if (current) fields[current] = stripQuotes(key[2].trim())
    } else if (current && /^\s+\S/.test(line)) {
      fields[current] = `${fields[current] ?? ''} ${line.trim()}`.trim()
    } else {
      current = null
    }
  }
  return fields
}

/** `<rootReal>/<dirName>/SKILL.md` as an entry, or null when there is nothing valid to list. */
function readSkillDir(rootReal: string, dirName: string, root: RootSpec): SkillEntry | null {
  if (!SAFE_NAME.test(dirName)) return null
  let skillFile: string
  try {
    skillFile = fs.realpathSync(path.join(rootReal, dirName, 'SKILL.md'))
  } catch {
    return null // no SKILL.md or a broken link: do not list a token that cannot work
  }
  // A link that leaves the root is skipped, as a symlink out of web/ is refused by the static server.
  if (!skillFile.startsWith(rootReal + path.sep)) return null

  let text: string
  try {
    const fd = fs.openSync(skillFile, 'r')
    try {
      const buffer = Buffer.alloc(FRONTMATTER_READ_BYTES)
      text = buffer.toString('utf8', 0, fs.readSync(fd, buffer, 0, FRONTMATTER_READ_BYTES, 0))
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return null
  }

  const frontmatter = parseDescription(text)
  // The directory is what the CLI registers, so it wins; the mismatch is logged for the GUI's server log.
  if (frontmatter.name && frontmatter.name !== dirName) {
    console.warn(`[Skills] "${root.group}" skill directory "${dirName}" has frontmatter name "${frontmatter.name}"; using the directory name.`)
  }
  const entry: SkillEntry = { token: `${root.tokenPrefix}${dirName}`, name: dirName, source: root.source, group: root.group }
  if (frontmatter.description) {
    // eslint-disable-next-line no-control-regex
    const description = frontmatter.description.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
    entry.description = description.length <= MAX_DESCRIPTION_LENGTH ? description : `${description.slice(0, MAX_DESCRIPTION_LENGTH - 1)}…`
  }
  return entry
}

/** One root, depth 1 (`<root>/<name>/SKILL.md`). Entries beyond the per-root cap are dropped and reported. */
function scanRoot(root: RootSpec, warnings: string[]): SkillEntry[] {
  let rootReal: string
  let dirNames: string[]
  try {
    rootReal = fs.realpathSync(root.dir)
    // Sorted before the cap so the catalog order and the cut are both alphabetical within the group.
    dirNames = fs.readdirSync(rootReal, { withFileTypes: true })
      .filter(d => d.isDirectory() || d.isSymbolicLink())
      .map(d => d.name)
      .sort((a, b) => a.localeCompare(b))
  } catch (err) {
    // A missing root is normal: most repos have no .claude/skills and not every plugin ships skills.
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') warnings.push(`could not read ${root.group} skills`)
    return []
  }

  const entries = dirNames.slice(0, MAX_DIR_ENTRIES_PER_ROOT)
    .map(dirName => readSkillDir(rootReal, dirName, root))
    .filter((entry): entry is SkillEntry => entry !== null)
  if (dirNames.length > MAX_DIR_ENTRIES_PER_ROOT) {
    warnings.push(`${root.group}: ${dirNames.length - MAX_DIR_ENTRIES_PER_ROOT} additional skill folders were not scanned (cap: ${MAX_DIR_ENTRIES_PER_ROOT} per root)`)
  }
  return entries
}

function scan(program: string, specs: AgentSkills, projectDir: string | undefined): SkillCatalog {
  const home = os.homedir()
  const project = projectDir ? path.resolve(projectDir) : undefined
  const roots: RootSpec[] = []
  for (const root of specs.roots) {
    const dir = expand(root.dir, home, project)
    if (dir) roots.push({ dir, source: root.source, group: root.source, tokenPrefix: '' })
  }
  const manifest = specs.plugins ? expand(specs.plugins, home, project) : undefined
  if (manifest) roots.push(...pluginRoots(manifest))

  const warnings: string[] = []
  const skills: SkillEntry[] = []
  for (const root of roots) {
    const found = scanRoot(root, warnings)
    const room = MAX_SKILLS_PER_CATALOG - skills.length
    skills.push(...found.slice(0, room))
    if (found.length > room) {
      warnings.push(`catalog capped at ${MAX_SKILLS_PER_CATALOG} skills; later entries were not included`)
      break
    }
  }
  return { program, invocation: specs.invocation, skills, ...(warnings.length ? { detail: warnings.join('; ') } : {}) }
}

/**
 * The skills installed for `program`, in the project directory the agent runs in (project -> personal -> plugins,
 * alphabetical within a group). Never rejects: a missing root is empty and an unreadable one is a `detail` line.
 */
export async function getSkillCatalog(program: string, projectDir?: string): Promise<SkillCatalog> {
  // Resolved first: a team stores "claude code" as typed, and every branch below goes by the adapter name.
  const adapter = resolveAgentProgram(program)
  if (!adapter) return { program, invocation: 'none', skills: [], detail: `unknown program "${program}"` }
  const specs = adapter.skills
  if (!specs || specs.invocation === 'none') {
    return { program: adapter.name, invocation: 'none', skills: [], detail: `${adapter.name} has no installed-skill support configured.` }
  }

  const key = `${adapter.name}\0${projectDir ?? ''}`
  const cached = cache.get(key)
  if (cached && cached.expiresAt > Date.now()) return cached.catalog

  let catalog: SkillCatalog
  try {
    catalog = scan(adapter.name, specs, projectDir)
  } catch {
    // Generic on purpose: an fs error's own text can carry an absolute path.
    catalog = { program: adapter.name, invocation: specs.invocation, skills: [], detail: 'skill catalog scan failed unexpectedly' }
  }
  remember(key, catalog)
  return catalog
}
