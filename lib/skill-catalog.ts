/**
 * Skill Catalog Probe — read-only discovery of the skills installed for an
 * agent CLI, for the "/" picker in the monitoring GUI composer. See
 * docs/superpowers/specs/2026-08-16-agent-skill-invocation-design.md §4.
 *
 * Mirrors lib/account-status.ts in shape: a fixed program lookup (via
 * agents.json/resolveAgentProgram rather than a hardcoded list here), a TTL
 * cache, an allowlisted output shape, and a promise that never rejects.
 * Where account-status.ts's security boundary is "never forward a raw
 * credential field", this module's is different but just as absolute:
 *
 * SECURITY: no absolute filesystem path may ever appear in a returned
 * SkillEntry or SkillCatalog — not in a field, not in `detail`. This catalog
 * crosses an HTTP boundary to a page any process on the loopback interface
 * can fetch (the API has no auth by design, see AGENTS.md), and a path would
 * leak the user's home-directory layout and their installed-plugin
 * inventory for free. Every string that reaches the caller is built from
 * directory names, plugin-manifest keys, and frontmatter text — never from
 * `path.join`/`fs.realpathSync` output directly.
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import { resolveAgentProgram } from './agent-config'
import type { SkillInvocation } from '../types/agent-program'

const CACHE_TTL_MS = 60_000

/** Hard bounds — see module header. This module walks a user-controlled
 * directory tree on every GUI poll, so every limit below is load-bearing,
 * not a nicety. */
const MAX_SKILLS_PER_CATALOG = 300
const MAX_DIR_ENTRIES_PER_ROOT = 200
const MAX_DESCRIPTION_LENGTH = 240
/** Frontmatter lives at the top of SKILL.md; bodies can run hundreds of KB. */
const FRONTMATTER_READ_BYTES = 4096

export type SkillSource = 'project' | 'personal' | 'plugin'

export interface SkillEntry {
  /** The exact text typed after "/" — e.g. "brandkit" or "superpowers:brainstorming". */
  token: string
  /** Display name. Always the directory name — see parseSkillDir() below. */
  name: string
  /** Frontmatter description, trimmed to MAX_DESCRIPTION_LENGTH. Absent if unparseable. */
  description?: string
  source: SkillSource
  /** Group heading: "project", "personal", or the plugin name. */
  group: string
}

export interface SkillCatalog {
  program: string
  invocation: SkillInvocation
  skills: SkillEntry[]
  /** Set when invocation === 'none', or when a root was unreadable/truncated. */
  detail?: string
}

interface CacheEntry {
  catalog: SkillCatalog
  expiresAt: number
}

/**
 * Keyed by `program + '\0' + (projectDir ?? '')`, per the design doc. Not
 * bounded by construction the way account-status.ts's five-program map is —
 * the key space is programs x live teams' working directories — but that is
 * itself bounded by how many teams can realistically be running at once, and
 * the 60s TTL means a stale key ages out rather than accumulating forever.
 */
const cache = new Map<string, CacheEntry>()

/** Clear the cache. Exists for tests; not exposed over HTTP. */
export function clearSkillCatalogCache(): void {
  cache.clear()
}

function cacheKey(program: string, projectDir?: string): string {
  return `${program}\0${projectDir ?? ''}`
}

function fromCache(key: string): SkillCatalog | undefined {
  const entry = cache.get(key)
  if (!entry) return undefined
  if (Date.now() >= entry.expiresAt) {
    cache.delete(key)
    return undefined
  }
  return entry.catalog
}

function toCache(key: string, catalog: SkillCatalog): void {
  cache.set(key, { catalog, expiresAt: Date.now() + CACHE_TTL_MS })
}

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'ENOENT'
}

/** One directory this module will look inside for `<name>/SKILL.md`. */
interface RootSpec {
  /** Filesystem path. Never leaves this module — see the header SECURITY note. */
  dir: string
  source: SkillSource
  group: string
  /** Prepended to the directory name to form the token — "" or "pluginName:". */
  tokenPrefix: string
}

/**
 * The program's own project/personal roots (§4.2). Plugin roots are
 * resolved separately, from the plugins manifest, in resolvePluginRoots().
 *
 * `projectDir` is the agent's own working directory, resolved server-side
 * from team state by the caller (see design doc §9) — this module never
 * infers it and never accepts one shaped like user input.
 */
function programRoots(program: string, projectDir: string | undefined): RootSpec[] {
  const home = os.homedir()
  const roots: RootSpec[] = []

  if (program === 'claude') {
    if (projectDir) {
      roots.push({ dir: path.join(projectDir, '.claude', 'skills'), source: 'project', group: 'project', tokenPrefix: '' })
    }
    roots.push({ dir: path.join(home, '.claude', 'skills'), source: 'personal', group: 'personal', tokenPrefix: '' })
  } else if (program === 'codex') {
    if (projectDir) {
      roots.push({ dir: path.join(projectDir, '.codex', 'skills'), source: 'project', group: 'project', tokenPrefix: '' })
    }
    // $CODEX_HOME defaults to ~/.codex, matching the codex CLI itself.
    const codexHome = (process.env['CODEX_HOME'] ?? '').trim() || path.join(home, '.codex')
    roots.push({ dir: path.join(codexHome, 'skills'), source: 'personal', group: 'personal', tokenPrefix: '' })
  }
  // Any other program has no skills convention (§3): no roots, empty catalog.

  return roots
}

/** Shape of ~/.claude/plugins/installed_plugins.json, narrowed to the fields read. */
interface PluginManifestEntry {
  scope?: unknown
  installPath?: unknown
}

/**
 * Plugin skill roots, from the manifest — never from a glob of the plugin
 * cache directory.
 *
 * Verified on the dev machine: the cache directory holds every installed
 * version of a plugin side by side (figma had 2.2.87, 2.2.91, and 2.2.95 at
 * once). Globbing `cache/*\/*\/*\/skills/*` would list the same skill three
 * times, two of them stale. `installed_plugins.json` gives one authoritative
 * `installPath` per plugin — that is the whole reason this function exists
 * instead of a readdir over the cache tree.
 *
 * Only relevant to claude — codex has no plugin-manifest concept (§4.2).
 */
function resolvePluginRoots(): RootSpec[] {
  const manifestPath = path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json')

  let raw: string
  try {
    raw = fs.readFileSync(manifestPath, 'utf8')
  } catch {
    // No plugins manifest — normal on a machine with no plugins installed.
    return []
  }

  let manifest: unknown
  try {
    manifest = JSON.parse(raw)
  } catch {
    return []
  }

  if (!manifest || typeof manifest !== 'object') return []
  const plugins = (manifest as { plugins?: unknown }).plugins
  if (!plugins || typeof plugins !== 'object') return []

  const roots: RootSpec[] = []
  for (const [key, value] of Object.entries(plugins as Record<string, unknown>)) {
    if (!Array.isArray(value) || value.length === 0) continue

    // The plugin name for the token/group is the part of the manifest key
    // before "@" — e.g. "figma@claude-plugins-official" -> "figma".
    const pluginName = key.split('@')[0]
    if (!pluginName) continue

    const entries = value as PluginManifestEntry[]
    // Where a key has multiple entries (different scopes), prefer a
    // "project" scope over "user", matching how the CLI itself resolves
    // them — a project-local override should win over the shared cache.
    const projectEntry = entries.find(e => e.scope === 'project' && typeof e.installPath === 'string')
    const chosen = projectEntry ?? entries.find(e => typeof e.installPath === 'string')
    if (!chosen || typeof chosen.installPath !== 'string') continue

    roots.push({
      dir: path.join(chosen.installPath, 'skills'),
      source: 'plugin',
      group: pluginName,
      tokenPrefix: `${pluginName}:`,
    })
  }

  // Alphabetical within the plugin group, per the design doc's ordering rule.
  roots.sort((a, b) => a.group.localeCompare(b.group))
  return roots
}

/**
 * Hand-rolled frontmatter parser over the leading `---` ... `---` block.
 * Deliberately not a YAML parser: this repo has no YAML dependency today,
 * and SKILL.md frontmatter is a two-key document (`name`, `description`),
 * not general YAML. A continuation line is any line indented under `name:`
 * or `description:` that does not itself start a new `key:` — those are
 * joined onto the current field with a single space.
 */
function parseFrontmatter(text: string): { name?: string; description?: string } {
  const lines = text.split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return {}

  let end = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      end = i
      break
    }
  }
  // The closing "---" never appeared within the 4KB read — either this
  // isn't really frontmatter, or the block is unusually large. Either way,
  // nothing here can be trusted as a complete field.
  if (end === -1) return {}

  const fields: { name?: string; description?: string } = {}
  let currentKey: 'name' | 'description' | null = null

  for (const line of lines.slice(1, end)) {
    const keyMatch = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (keyMatch) {
      const [, key, rawValue] = keyMatch
      if (key === 'name' || key === 'description') {
        currentKey = key
        fields[key] = stripQuotes(rawValue.trim())
      } else {
        // Some other top-level key (e.g. "allowed-tools:") — stop treating
        // subsequent indented lines as a continuation of the last field.
        currentKey = null
      }
      continue
    }

    if (currentKey && /^\s+\S/.test(line)) {
      fields[currentKey] = `${fields[currentKey] ?? ''} ${line.trim()}`.trim()
      continue
    }

    // Blank line, or a non-indented line that isn't a "key: value" — the
    // continuation run, if any, is over.
    currentKey = null
  }

  return fields
}

function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1)
    }
  }
  return value
}

function truncateDescription(description: string): string {
  const trimmed = description.trim()
  if (trimmed.length <= MAX_DESCRIPTION_LENGTH) return trimmed
  return `${trimmed.slice(0, MAX_DESCRIPTION_LENGTH - 1)}…`
}

/**
 * Read one `<rootReal>/<dirName>/SKILL.md` and build its SkillEntry, or
 * return null if there is nothing valid to list. `rootReal` is already the
 * root's realpath (resolved once by the caller); this function resolves the
 * candidate SKILL.md's realpath and checks containment under it — mirroring
 * `resolveStaticFile()` in server.ts. A symlinked skill directory (or a
 * symlinked SKILL.md) that resolves outside the declared root is skipped
 * rather than followed, the same way a symlink escaping PUBLIC_DIR is
 * refused there.
 */
function readSkillDir(rootReal: string, dirName: string, root: RootSpec): SkillEntry | null {
  const candidate = path.join(rootReal, dirName, 'SKILL.md')

  let realSkillPath: string
  try {
    realSkillPath = fs.realpathSync(candidate)
  } catch {
    // No SKILL.md, or a broken symlink — skip the directory entirely rather
    // than list it with a broken token (§4.3).
    return null
  }

  if (!realSkillPath.startsWith(rootReal + path.sep)) {
    return null
  }

  let text: string
  try {
    const fd = fs.openSync(realSkillPath, 'r')
    try {
      const buf = Buffer.alloc(FRONTMATTER_READ_BYTES)
      const bytesRead = fs.readSync(fd, buf, 0, FRONTMATTER_READ_BYTES, 0)
      text = buf.toString('utf8', 0, bytesRead)
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return null
  }

  const frontmatter = parseFrontmatter(text)

  // The directory name is the invocation token, not the frontmatter name —
  // it is what is actually on disk and what the CLI itself registers. On a
  // mismatch the directory still wins; logged once so it is visible in the
  // GUI's server log (console.warn is teed into the log buffer) without
  // failing the scan.
  if (frontmatter.name && frontmatter.name !== dirName) {
    console.warn(
      `skill-catalog: "${root.group}" skill directory "${dirName}" has frontmatter name ` +
      `"${frontmatter.name}" — using the directory name as the invocation token.`,
    )
  }

  const entry: SkillEntry = {
    token: `${root.tokenPrefix}${dirName}`,
    name: dirName,
    source: root.source,
    group: root.group,
  }
  if (frontmatter.description) {
    entry.description = truncateDescription(frontmatter.description)
  }
  return entry
}

/**
 * Scan one root, depth 1 only (`<root>/<name>/SKILL.md` — no recursion).
 * Directory entries are capped at MAX_DIR_ENTRIES_PER_ROOT; excess is
 * dropped and reported via `warnings`, never silently truncated (§4.4).
 */
function scanRoot(root: RootSpec, warnings: string[]): SkillEntry[] {
  let rootReal: string
  try {
    rootReal = fs.realpathSync(root.dir)
  } catch (err) {
    // A missing root is normal — most users have no .claude/skills in a
    // given repo, and not every plugin ships a skills/ folder.
    if (isEnoent(err)) return []
    warnings.push(`could not read ${root.group} skills`)
    return []
  }

  let dirents: fs.Dirent[]
  try {
    dirents = fs.readdirSync(rootReal, { withFileTypes: true })
  } catch {
    warnings.push(`could not read ${root.group} skills`)
    return []
  }

  // Sorted up front so both the 200-cap and the final catalog order are
  // alphabetical within the group, per the design doc's ordering rule.
  // isSymbolicLink() entries are included here (a skill dir published via a
  // symlink is legitimate); readSkillDir()'s containment check is what
  // guards against one that resolves outside the root.
  const dirNames = dirents
    .filter(d => d.isDirectory() || d.isSymbolicLink())
    .map(d => d.name)
    .sort((a, b) => a.localeCompare(b))

  const truncated = dirNames.length > MAX_DIR_ENTRIES_PER_ROOT
  const boundedDirNames = truncated ? dirNames.slice(0, MAX_DIR_ENTRIES_PER_ROOT) : dirNames

  const entries: SkillEntry[] = []
  for (const dirName of boundedDirNames) {
    const entry = readSkillDir(rootReal, dirName, root)
    if (entry) entries.push(entry)
  }

  if (truncated) {
    warnings.push(
      `${root.group}: ${dirNames.length - MAX_DIR_ENTRIES_PER_ROOT} additional skill folders were not ` +
      `scanned (cap: ${MAX_DIR_ENTRIES_PER_ROOT} per root)`,
    )
  }

  return entries
}

async function buildCatalog(program: string, projectDir: string | undefined, invocation: SkillInvocation): Promise<SkillCatalog> {
  if (invocation === 'none') {
    return {
      program,
      invocation,
      skills: [],
      detail: `${program} has no installed-skill picker support.`,
    }
  }

  const warnings: string[] = []
  // §2 ordering: project -> personal -> plugin. programRoots() already
  // returns project before personal for the program's own roots; plugin
  // roots (claude only) are appended last and are already alphabetical
  // within themselves (resolvePluginRoots sorts by group).
  const roots: RootSpec[] = [...programRoots(program, projectDir)]
  if (program === 'claude') roots.push(...resolvePluginRoots())

  const skills: SkillEntry[] = []
  for (const root of roots) {
    const rootSkills = scanRoot(root, warnings)
    if (skills.length + rootSkills.length > MAX_SKILLS_PER_CATALOG) {
      const room = MAX_SKILLS_PER_CATALOG - skills.length
      if (room > 0) skills.push(...rootSkills.slice(0, room))
      warnings.push(`catalog capped at ${MAX_SKILLS_PER_CATALOG} skills; later entries were not included`)
      break
    }
    skills.push(...rootSkills)
  }

  return {
    program,
    invocation,
    skills,
    ...(warnings.length ? { detail: warnings.join('; ') } : {}),
  }
}

/**
 * Report the skills installed for `program`, optionally scoped to a
 * project directory (the agent's own working directory). Read-only: this
 * module never installs, enables, disables, or edits a skill, and never
 * writes anything to disk.
 *
 * Never rejects — a missing root is normal and an unreadable one degrades
 * to a `detail` string, exactly like lib/account-status.ts never throwing
 * for an agent CLI that isn't installed.
 */
export async function getSkillCatalog(program: string, projectDir?: string): Promise<SkillCatalog> {
  const key = cacheKey(program, projectDir)
  const cached = fromCache(key)
  if (cached) return cached

  const invocation: SkillInvocation = resolveAgentProgram(program).skillInvocation ?? 'none'

  let catalog: SkillCatalog
  try {
    catalog = await buildCatalog(program, projectDir, invocation)
  } catch {
    // Defensive only: every fallible step above already has its own
    // try/catch. If something still throws, degrade to an empty catalog
    // rather than let it escape as a rejection — this function's contract
    // is "never rejects" (§4.4). The message is intentionally generic
    // (never the caught error's own text) so a filesystem error that
    // happens to embed an absolute path can never reach the caller.
    catalog = {
      program,
      invocation,
      skills: [],
      detail: 'skill catalog scan failed unexpectedly',
    }
  }

  toCache(key, catalog)
  return catalog
}
