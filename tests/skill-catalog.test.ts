/**
 * lib/skill-catalog.ts is a read-only filesystem probe over each agent's
 * installed skills. Following this repo's convention (see
 * tests/account-status.test.ts, tests/readiness-gates.test.ts), it is tested
 * against a real fixture tree under os.tmpdir() rather than mocked fs calls
 * — the parser and the directory walk are exercised for real.
 *
 * `os.homedir()` is spied so "~/.claude/skills" and
 * "~/.claude/plugins/installed_plugins.json" resolve inside a disposable
 * fixture directory instead of the real machine's home directory.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { clearSkillCatalogCache, getSkillCatalog } from '../lib/skill-catalog'

let fixtureRoots: string[]

function makeFixtureRoot(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  fixtureRoots.push(dir)
  return dir
}

/** Build a SKILL.md's text. Frontmatter lines are joined verbatim so tests can
 * exercise continuation lines, quoting, and "no frontmatter at all". */
function skillMd(opts: { frontmatterLines?: string[]; body?: string } = {}): string {
  const parts: string[] = []
  if (opts.frontmatterLines) {
    parts.push('---', ...opts.frontmatterLines, '---', '')
  }
  parts.push(opts.body ?? '# Skill body\n\nSome instructions.')
  return parts.join('\n')
}

/** Create `<root>/<dirName>/SKILL.md` with the given content. */
function writeSkill(root: string, dirName: string, content: string): void {
  const dir = path.join(root, dirName)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'SKILL.md'), content, 'utf8')
}

/** Write ~/.claude/plugins/installed_plugins.json under `home`. */
function writePluginManifest(home: string, plugins: Record<string, Array<Record<string, unknown>>>): void {
  const manifestDir = path.join(home, '.claude', 'plugins')
  fs.mkdirSync(manifestDir, { recursive: true })
  fs.writeFileSync(
    path.join(manifestDir, 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins }, null, 2),
    'utf8',
  )
}

describe('skill-catalog', () => {
  beforeEach(() => {
    fixtureRoots = []
    clearSkillCatalogCache()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env['CODEX_HOME']
    for (const dir of fixtureRoots) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('never rejects and returns an empty catalog when no roots exist', async () => {
    const home = makeFixtureRoot('skillcat-empty-')
    vi.spyOn(os, 'homedir').mockReturnValue(home)

    const catalog = await getSkillCatalog('claude')

    expect(catalog.program).toBe('claude')
    expect(catalog.invocation).toBe('slash')
    expect(catalog.skills).toEqual([])
    expect(catalog.detail).toBeUndefined()
  })

  it('disables the picker with a detail string when invocation is "none"', async () => {
    const home = makeFixtureRoot('skillcat-none-')
    vi.spyOn(os, 'homedir').mockReturnValue(home)

    const catalog = await getSkillCatalog('gemini')

    expect(catalog.invocation).toBe('none')
    expect(catalog.skills).toEqual([])
    expect(catalog.detail).toBeTruthy()
  })

  it('reads a project skill and a personal skill, project before personal, alphabetical within group', async () => {
    const home = makeFixtureRoot('skillcat-home-')
    const projectDir = makeFixtureRoot('skillcat-project-')
    vi.spyOn(os, 'homedir').mockReturnValue(home)

    writeSkill(path.join(projectDir, '.claude', 'skills'), 'zzz-project', skillMd())
    writeSkill(path.join(projectDir, '.claude', 'skills'), 'aaa-project', skillMd())
    writeSkill(path.join(home, '.claude', 'skills'), 'bbb-personal', skillMd())
    writeSkill(path.join(home, '.claude', 'skills'), 'aaa-personal', skillMd())

    const catalog = await getSkillCatalog('claude', projectDir)

    expect(catalog.skills.map(s => `${s.source}:${s.token}`)).toEqual([
      'project:aaa-project',
      'project:zzz-project',
      'personal:aaa-personal',
      'personal:bbb-personal',
    ])
  })

  /**
   * The registry stores whatever program string the team was created with, and
   * the GUI's new-team field defaults to "codex, claude code" — so the string
   * that actually reaches this module in production is "claude code", not
   * "claude". Every other consumer normalizes through resolveAgentProgram()
   * before branching; this module must too, or it reports invocation:'slash'
   * (which does go through resolveAgentProgram) alongside an empty skills list.
   */
  it('resolves a program alias like "claude code" to the same roots as "claude"', async () => {
    const home = makeFixtureRoot('skillcat-alias-home-')
    const projectDir = makeFixtureRoot('skillcat-alias-project-')
    vi.spyOn(os, 'homedir').mockReturnValue(home)

    writeSkill(path.join(projectDir, '.claude', 'skills'), 'aaa-project', skillMd())
    writeSkill(path.join(home, '.claude', 'skills'), 'bbb-personal', skillMd())

    const catalog = await getSkillCatalog('claude code', projectDir)

    expect(catalog.invocation).toBe('slash')
    expect(catalog.skills.map(s => `${s.source}:${s.token}`)).toEqual([
      'project:aaa-project',
      'personal:bbb-personal',
    ])
  })

  it('parses a single-line quoted description', async () => {
    const home = makeFixtureRoot('skillcat-home-')
    vi.spyOn(os, 'homedir').mockReturnValue(home)

    writeSkill(
      path.join(home, '.claude', 'skills'),
      'brainstorming',
      skillMd({
        frontmatterLines: [
          'name: brainstorming',
          'description: "You MUST use this before any creative work."',
        ],
      }),
    )

    const catalog = await getSkillCatalog('claude')
    const entry = catalog.skills.find(s => s.token === 'brainstorming')

    expect(entry?.description).toBe('You MUST use this before any creative work.')
  })

  it('joins indented continuation lines onto the description with a single space', async () => {
    const home = makeFixtureRoot('skillcat-home-')
    vi.spyOn(os, 'homedir').mockReturnValue(home)

    writeSkill(
      path.join(home, '.claude', 'skills'),
      'multiline-desc',
      skillMd({
        frontmatterLines: [
          'name: multiline-desc',
          'description: First line of the description',
          '  continues here with more detail',
          '  and a third line to finish it off.',
        ],
      }),
    )

    const catalog = await getSkillCatalog('claude')
    const entry = catalog.skills.find(s => s.token === 'multiline-desc')

    expect(entry?.description).toBe(
      'First line of the description continues here with more detail and a third line to finish it off.',
    )
  })

  it('treats a skill with no frontmatter as nameable but description-less', async () => {
    const home = makeFixtureRoot('skillcat-home-')
    vi.spyOn(os, 'homedir').mockReturnValue(home)

    writeSkill(path.join(home, '.claude', 'skills'), 'no-frontmatter', skillMd({ frontmatterLines: undefined, body: '# Just a body\nNo frontmatter block at all.' }))

    const catalog = await getSkillCatalog('claude')
    const entry = catalog.skills.find(s => s.token === 'no-frontmatter')

    expect(entry).toBeDefined()
    expect(entry?.name).toBe('no-frontmatter')
    expect(entry?.description).toBeUndefined()
  })

  it('skips a skill directory with no SKILL.md entirely, rather than listing a broken token', async () => {
    const home = makeFixtureRoot('skillcat-home-')
    vi.spyOn(os, 'homedir').mockReturnValue(home)

    const skillsRoot = path.join(home, '.claude', 'skills')
    fs.mkdirSync(path.join(skillsRoot, 'empty-dir'), { recursive: true })
    writeSkill(skillsRoot, 'real-skill', skillMd())

    const catalog = await getSkillCatalog('claude')

    expect(catalog.skills.map(s => s.token)).toEqual(['real-skill'])
  })

  it('directory name wins over a mismatched frontmatter name, and warns once', async () => {
    const home = makeFixtureRoot('skillcat-home-')
    vi.spyOn(os, 'homedir').mockReturnValue(home)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    writeSkill(
      path.join(home, '.claude', 'skills'),
      'on-disk-dir-name',
      skillMd({ frontmatterLines: ['name: totally-different-frontmatter-name', 'description: whatever'] }),
    )

    const catalog = await getSkillCatalog('claude')
    const entry = catalog.skills.find(s => s.token === 'on-disk-dir-name')

    expect(entry).toBeDefined()
    expect(entry?.name).toBe('on-disk-dir-name')
    expect(catalog.skills.some(s => s.token.includes('totally-different-frontmatter-name'))).toBe(false)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0][0]).toContain('on-disk-dir-name')
    expect(warnSpy.mock.calls[0][0]).toContain('totally-different-frontmatter-name')
  })

  it('resolves a plugin skill from the manifest installPath, not the newest directory in the cache', async () => {
    // Regression fixture for the exact scenario the design doc calls out:
    // multiple versions cached side by side, only the manifest's installPath
    // is authoritative.
    const home = makeFixtureRoot('skillcat-home-')
    vi.spyOn(os, 'homedir').mockReturnValue(home)

    const cacheBase = path.join(home, '.claude', 'plugins', 'cache', 'claude-plugins-official', 'figma')
    const stalePath = path.join(cacheBase, '2.2.87')
    const currentPath = path.join(cacheBase, '2.2.95')
    // A version newer than the manifest's, to prove a glob-the-cache
    // approach (which would find this one too, and might sort it last/first
    // depending on the glob) is not what's happening here.
    const newerUnlistedPath = path.join(cacheBase, '2.2.99')

    writeSkill(
      path.join(stalePath, 'skills'),
      'figma-use',
      skillMd({ frontmatterLines: ['name: figma-use', 'description: STALE VERSION'] }),
    )
    writeSkill(
      path.join(currentPath, 'skills'),
      'figma-use',
      skillMd({ frontmatterLines: ['name: figma-use', 'description: CURRENT VERSION'] }),
    )
    writeSkill(
      path.join(newerUnlistedPath, 'skills'),
      'figma-use',
      skillMd({ frontmatterLines: ['name: figma-use', 'description: UNLISTED NEWER VERSION'] }),
    )

    writePluginManifest(home, {
      'figma@claude-plugins-official': [
        { scope: 'user', installPath: currentPath, version: '2.2.95' },
      ],
    })

    const catalog = await getSkillCatalog('claude')
    const figmaEntries = catalog.skills.filter(s => s.group === 'figma')

    expect(figmaEntries).toHaveLength(1)
    expect(figmaEntries[0]).toEqual({
      token: 'figma:figma-use',
      name: 'figma-use',
      description: 'CURRENT VERSION',
      source: 'plugin',
      group: 'figma',
    })
  })

  it('prefers a "project" scope entry over "user" when a plugin key has both', async () => {
    const home = makeFixtureRoot('skillcat-home-')
    vi.spyOn(os, 'homedir').mockReturnValue(home)

    const userPath = path.join(home, '.claude', 'plugins', 'cache', 'marketplace', 'demo', 'user-version')
    const projectPath = path.join(home, '.claude', 'plugins', 'cache', 'marketplace', 'demo', 'project-version')

    writeSkill(path.join(userPath, 'skills'), 'demo-skill', skillMd({ frontmatterLines: ['description: from user scope'] }))
    writeSkill(path.join(projectPath, 'skills'), 'demo-skill', skillMd({ frontmatterLines: ['description: from project scope'] }))

    writePluginManifest(home, {
      'demo@marketplace': [
        { scope: 'user', installPath: userPath, version: 'user-version' },
        { scope: 'project', installPath: projectPath, version: 'project-version' },
      ],
    })

    const catalog = await getSkillCatalog('claude')
    const entry = catalog.skills.find(s => s.group === 'demo')

    expect(entry?.description).toBe('from project scope')
  })

  it('caps directory entries at 200 per root and reports the drop in detail', async () => {
    const home = makeFixtureRoot('skillcat-home-')
    vi.spyOn(os, 'homedir').mockReturnValue(home)

    const skillsRoot = path.join(home, '.claude', 'skills')
    for (let i = 0; i < 250; i++) {
      writeSkill(skillsRoot, `skill-${String(i).padStart(4, '0')}`, skillMd())
    }

    const catalog = await getSkillCatalog('claude')

    expect(catalog.skills).toHaveLength(200)
    expect(catalog.detail).toBeTruthy()
    expect(catalog.detail).toContain('50')
  }, 20_000)

  it('caps the whole catalog at 300 skills across roots and reports the drop in detail', async () => {
    const home = makeFixtureRoot('skillcat-home-')
    const projectDir = makeFixtureRoot('skillcat-project-')
    vi.spyOn(os, 'homedir').mockReturnValue(home)

    // 150 + 150 + 100 = 400 directories total, none of which individually
    // exceeds the 200-per-root cap, so this exercises the 300-skill global
    // cap specifically rather than the per-root cap above.
    const projectSkills = path.join(projectDir, '.claude', 'skills')
    const personalSkills = path.join(home, '.claude', 'skills')
    for (let i = 0; i < 150; i++) writeSkill(projectSkills, `p-${String(i).padStart(4, '0')}`, skillMd())
    for (let i = 0; i < 150; i++) writeSkill(personalSkills, `u-${String(i).padStart(4, '0')}`, skillMd())

    const pluginPath = path.join(home, '.claude', 'plugins', 'cache', 'marketplace', 'bulk', 'v1')
    for (let i = 0; i < 100; i++) {
      writeSkill(path.join(pluginPath, 'skills'), `b-${String(i).padStart(4, '0')}`, skillMd())
    }
    writePluginManifest(home, { 'bulk@marketplace': [{ scope: 'user', installPath: pluginPath, version: 'v1' }] })

    const catalog = await getSkillCatalog('claude', projectDir)

    expect(catalog.skills).toHaveLength(300)
    expect(catalog.detail).toBeTruthy()
    expect(catalog.detail).toContain('300')
  }, 20_000)

  it('truncates an overlong description to 240 characters with an ellipsis', async () => {
    const home = makeFixtureRoot('skillcat-home-')
    vi.spyOn(os, 'homedir').mockReturnValue(home)

    const longDescription = 'x'.repeat(300)
    writeSkill(
      path.join(home, '.claude', 'skills'),
      'long-desc',
      skillMd({ frontmatterLines: ['description: ' + longDescription] }),
    )

    const catalog = await getSkillCatalog('claude')
    const entry = catalog.skills.find(s => s.token === 'long-desc')

    expect(entry?.description).toHaveLength(240)
    expect(entry?.description?.endsWith('…')).toBe(true)
  })

  it('never lets an absolute filesystem path escape into the serialized catalog', async () => {
    const home = makeFixtureRoot('skillcat-home-')
    const projectDir = makeFixtureRoot('skillcat-project-')
    vi.spyOn(os, 'homedir').mockReturnValue(home)

    writeSkill(path.join(projectDir, '.claude', 'skills'), 'proj-skill', skillMd({ frontmatterLines: ['description: lives in the project dir'] }))
    writeSkill(path.join(home, '.claude', 'skills'), 'personal-skill', skillMd())

    const pluginPath = path.join(home, '.claude', 'plugins', 'cache', 'marketplace', 'demo', '1.0.0')
    writeSkill(path.join(pluginPath, 'skills'), 'demo-skill', skillMd())
    writePluginManifest(home, { 'demo@marketplace': [{ scope: 'user', installPath: pluginPath, version: '1.0.0' }] })

    const catalog = await getSkillCatalog('claude', projectDir)
    const serialized = JSON.stringify(catalog)

    expect(serialized).not.toContain(home)
    expect(serialized).not.toContain(projectDir)
    // Sanity: the fixture actually produced real entries (a vacuous "no
    // paths" pass because nothing was scanned would defeat the assertion).
    expect(catalog.skills.length).toBeGreaterThanOrEqual(3)
  })

  it('serves cached results within the TTL and re-scans only after clearSkillCatalogCache()', async () => {
    const home = makeFixtureRoot('skillcat-home-')
    vi.spyOn(os, 'homedir').mockReturnValue(home)

    const skillsRoot = path.join(home, '.claude', 'skills')
    writeSkill(skillsRoot, 'first-skill', skillMd())

    const first = await getSkillCatalog('claude')
    expect(first.skills.map(s => s.token)).toEqual(['first-skill'])

    // Added after the first call — a cached result must not see it.
    writeSkill(skillsRoot, 'second-skill', skillMd())
    const second = await getSkillCatalog('claude')
    expect(second.skills.map(s => s.token)).toEqual(['first-skill'])

    clearSkillCatalogCache()
    const third = await getSkillCatalog('claude')
    expect(third.skills.map(s => s.token).sort()).toEqual(['first-skill', 'second-skill'])
  })

  it('keys the cache by projectDir, so two agents in different worktrees do not share a catalog', async () => {
    const home = makeFixtureRoot('skillcat-home-')
    const projectA = makeFixtureRoot('skillcat-projectA-')
    const projectB = makeFixtureRoot('skillcat-projectB-')
    vi.spyOn(os, 'homedir').mockReturnValue(home)

    writeSkill(path.join(projectA, '.claude', 'skills'), 'only-in-a', skillMd())
    writeSkill(path.join(projectB, '.claude', 'skills'), 'only-in-b', skillMd())

    const catalogA = await getSkillCatalog('claude', projectA)
    const catalogB = await getSkillCatalog('claude', projectB)

    expect(catalogA.skills.map(s => s.token)).toContain('only-in-a')
    expect(catalogA.skills.map(s => s.token)).not.toContain('only-in-b')
    expect(catalogB.skills.map(s => s.token)).toContain('only-in-b')
    expect(catalogB.skills.map(s => s.token)).not.toContain('only-in-a')
  })

  it('reads codex skills from $CODEX_HOME, defaulting to ~/.codex', async () => {
    const home = makeFixtureRoot('skillcat-home-')
    const codexHome = makeFixtureRoot('skillcat-codexhome-')
    vi.spyOn(os, 'homedir').mockReturnValue(home)
    process.env['CODEX_HOME'] = codexHome

    writeSkill(path.join(codexHome, 'skills'), 'codex-only-skill', skillMd())
    // A skill under the default ~/.codex location must NOT be picked up
    // while CODEX_HOME overrides it.
    writeSkill(path.join(home, '.codex', 'skills'), 'default-location-skill', skillMd())

    const catalog = await getSkillCatalog('codex')

    expect(catalog.skills.map(s => s.token)).toEqual(['codex-only-skill'])
  })

  it('never applies plugin resolution to codex (no plugin-manifest concept for that program)', async () => {
    const home = makeFixtureRoot('skillcat-home-')
    vi.spyOn(os, 'homedir').mockReturnValue(home)
    delete process.env['CODEX_HOME']

    const pluginPath = path.join(home, '.claude', 'plugins', 'cache', 'marketplace', 'demo', '1.0.0')
    writeSkill(path.join(pluginPath, 'skills'), 'demo-skill', skillMd())
    writePluginManifest(home, { 'demo@marketplace': [{ scope: 'user', installPath: pluginPath, version: '1.0.0' }] })

    const catalog = await getSkillCatalog('codex')

    expect(catalog.skills).toEqual([])
  })

  it('degrades a corrupt plugin manifest to "no plugin skills" rather than throwing', async () => {
    const home = makeFixtureRoot('skillcat-home-')
    vi.spyOn(os, 'homedir').mockReturnValue(home)

    const manifestDir = path.join(home, '.claude', 'plugins')
    fs.mkdirSync(manifestDir, { recursive: true })
    fs.writeFileSync(path.join(manifestDir, 'installed_plugins.json'), '{ this is not valid json', 'utf8')

    writeSkill(path.join(home, '.claude', 'skills'), 'personal-skill', skillMd())

    await expect(getSkillCatalog('claude')).resolves.toEqual(
      expect.objectContaining({ skills: [{ token: 'personal-skill', name: 'personal-skill', source: 'personal', group: 'personal' }] }),
    )
  })

  describe('symlink containment (skipped when the host cannot create directory junctions)', () => {
    let junctionsSupported = true

    beforeEach(() => {
      const probe = makeFixtureRoot('skillcat-junction-probe-')
      const target = path.join(probe, 'target')
      fs.mkdirSync(target)
      try {
        fs.symlinkSync(target, path.join(probe, 'link'), 'junction')
      } catch {
        junctionsSupported = false
      }
    })

    it('skips a skill directory whose junction resolves outside the declared root', async () => {
      if (!junctionsSupported) {
        // Windows junctions need no special privilege, but guard anyway so
        // this test degrades to a no-op rather than failing on a locked-down
        // host, instead of asserting something false.
        return
      }

      const home = makeFixtureRoot('skillcat-home-')
      const outside = makeFixtureRoot('skillcat-outside-')
      vi.spyOn(os, 'homedir').mockReturnValue(home)

      // A skill that genuinely lives outside ~/.claude/skills entirely.
      writeSkill(outside, 'escaped-skill', skillMd({ frontmatterLines: ['description: should never be listed'] }))

      const skillsRoot = path.join(home, '.claude', 'skills')
      fs.mkdirSync(skillsRoot, { recursive: true })
      // A directory *inside* the declared root that is a junction pointing
      // at the outside directory — the escape vector this containment
      // check exists for.
      fs.symlinkSync(outside, path.join(skillsRoot, 'escaped-skill'), 'junction')

      // A normal, contained skill, to prove the scan still works otherwise.
      writeSkill(skillsRoot, 'normal-skill', skillMd())

      const catalog = await getSkillCatalog('claude')

      expect(catalog.skills.map(s => s.token)).toEqual(['normal-skill'])
    })
  })
})
