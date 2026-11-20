import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearAgentsConfigCache } from '../src/adapters/agent-config'
import {
  clearSkillCatalogCache, getSkillCatalog, MAX_CACHED_CATALOGS, MAX_DESCRIPTION_LENGTH,
  MAX_DIR_ENTRIES_PER_ROOT, MAX_SKILLS_PER_CATALOG,
} from '../src/adapters/skills'

/**
 * The catalog is a read-only filesystem probe, so it is tested against real trees under os.tmpdir().
 * os.homedir() is spied: "{home}" resolves inside a disposable directory, never the real ~/.claude or
 * ~/.codex. The programs come from the checked-in agents.json, which also proves its `skills` entries load.
 */

let roots: string[]
const tmp = (prefix: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  roots.push(dir)
  return dir
}

const skillMd = (frontmatter?: string[], body = '# Skill body\n\nInstructions.'): string =>
  [...(frontmatter ? ['---', ...frontmatter, '---', ''] : []), body].join('\n')

function writeSkill(root: string, dirName: string, content = skillMd()): void {
  fs.mkdirSync(path.join(root, dirName), { recursive: true })
  fs.writeFileSync(path.join(root, dirName, 'SKILL.md'), content, 'utf8')
}

function writeManifest(home: string, plugins: Record<string, Array<Record<string, unknown>>>): string {
  const dir = path.join(home, '.claude', 'plugins')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'installed_plugins.json'), JSON.stringify({ version: 2, plugins }), 'utf8')
  return dir
}

describe('getSkillCatalog', () => {
  const savedConfig = process.env.ENSEMBLE_AGENTS_CONFIG

  beforeEach(() => {
    roots = []
    delete process.env.ENSEMBLE_AGENTS_CONFIG
    delete process.env.CODEX_HOME
    clearAgentsConfigCache()
    clearSkillCatalogCache()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env.CODEX_HOME
    if (savedConfig !== undefined) process.env.ENSEMBLE_AGENTS_CONFIG = savedConfig
    clearAgentsConfigCache()
    for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true })
  })

  const home = (): string => {
    const dir = tmp('skills-home-')
    vi.spyOn(os, 'homedir').mockReturnValue(dir)
    return dir
  }
  const tokens = (catalog: { skills: Array<{ token: string }> }): string[] => catalog.skills.map(s => s.token)

  it('is empty, not an error, when no root exists', async () => {
    home()
    const catalog = await getSkillCatalog('claude')
    expect(catalog).toEqual({ program: 'claude', invocation: 'slash', skills: [] })
  })

  it('answers "none" with a generic reason for a program without a skills entry, and for an unknown one', async () => {
    home()
    const gemini = await getSkillCatalog('gemini')
    expect(gemini).toMatchObject({ program: 'gemini', invocation: 'none', skills: [] })
    expect(gemini.detail).toContain('gemini has no installed-skill support')
    expect(await getSkillCatalog('nonesuch')).toMatchObject({ invocation: 'none', skills: [] })
  })

  it('lists project, then personal, then plugin skills, alphabetical within a group', async () => {
    const h = home()
    const project = tmp('skills-project-')
    writeSkill(path.join(project, '.claude', 'skills'), 'zzz-project')
    writeSkill(path.join(project, '.claude', 'skills'), 'aaa-project')
    writeSkill(path.join(h, '.claude', 'skills'), 'bbb-personal')
    writeSkill(path.join(h, '.claude', 'skills'), 'aaa-personal')
    const zeta = path.join(h, 'plug', 'zeta')
    const alpha = path.join(h, 'plug', 'alpha')
    writeSkill(path.join(zeta, 'skills'), 'z-skill')
    writeSkill(path.join(alpha, 'skills'), 'a-skill')
    writeManifest(h, { 'zeta@market': [{ scope: 'user', installPath: zeta }], 'alpha@market': [{ scope: 'user', installPath: alpha }] })

    const catalog = await getSkillCatalog('claude', project)

    expect(catalog.skills.map(s => `${s.source}:${s.token}`)).toEqual([
      'project:aaa-project', 'project:zzz-project', 'personal:aaa-personal', 'personal:bbb-personal',
      'plugin:alpha:a-skill', 'plugin:zeta:z-skill',
    ])
  })

  it('resolves "claude code", the way a team stores the program, to the same roots as "claude"', async () => {
    const h = home()
    writeSkill(path.join(h, '.claude', 'skills'), 'personal-skill')
    const catalog = await getSkillCatalog('claude code')
    expect(catalog.program).toBe('claude')
    expect(tokens(catalog)).toEqual(['personal-skill'])
  })

  describe('frontmatter', () => {
    const descriptionOf = async (frontmatter: string[] | undefined, body?: string) => {
      const h = home()
      writeSkill(path.join(h, '.claude', 'skills'), 'the-skill', skillMd(frontmatter, body))
      clearSkillCatalogCache()
      return (await getSkillCatalog('claude')).skills[0]
    }

    it('reads a quoted single-line description', async () => {
      expect((await descriptionOf(['name: the-skill', 'description: "You MUST use this."']))?.description).toBe('You MUST use this.')
    })

    it('joins indented continuation lines with one space', async () => {
      const entry = await descriptionOf(['description: First line', '  second line', '  third line.', 'allowed-tools: Read', '  not part of it'])
      expect(entry?.description).toBe('First line second line third line.')
    })

    it('lists a skill without frontmatter by its directory, with no description', async () => {
      const entry = await descriptionOf(undefined, '# Just a body')
      expect(entry).toEqual({ token: 'the-skill', name: 'the-skill', source: 'personal', group: 'personal' })
    })

    it('ignores a frontmatter block that never closes within the bytes read', async () => {
      const entry = await descriptionOf(undefined, `---\ndescription: ${'x'.repeat(5000)}\n`)
      expect(entry?.description).toBeUndefined()
    })

    it(`cuts a description at ${MAX_DESCRIPTION_LENGTH} characters with an ellipsis`, async () => {
      const entry = await descriptionOf([`description: ${'x'.repeat(300)}`])
      expect(entry?.description).toHaveLength(MAX_DESCRIPTION_LENGTH)
      expect(entry?.description?.endsWith('…')).toBe(true)
    })

    it('lets the directory name win over a different frontmatter name, and warns once', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const entry = await descriptionOf(['name: another-name', 'description: d'])
      expect(entry?.token).toBe('the-skill')
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0][0])).toContain('another-name')
    })
  })

  it('skips a directory with no SKILL.md, and a name that is not safe to type', async () => {
    const h = home()
    const root = path.join(h, '.claude', 'skills')
    fs.mkdirSync(path.join(root, 'empty-dir'), { recursive: true })
    writeSkill(root, 'real-skill')
    writeSkill(root, 'has space')
    writeSkill(root, '.hidden')
    expect(tokens(await getSkillCatalog('claude'))).toEqual(['real-skill'])
  })

  describe('plugins', () => {
    it('takes the install path named by the manifest, not every version in the cache', async () => {
      const h = home()
      const cache = path.join(h, '.claude', 'plugins', 'cache', 'market', 'figma')
      for (const [version, text] of [['2.2.87', 'STALE'], ['2.2.95', 'CURRENT'], ['2.2.99', 'UNLISTED NEWER']]) {
        writeSkill(path.join(cache, version, 'skills'), 'figma-use', skillMd(['name: figma-use', `description: ${text}`]))
      }
      writeManifest(h, { 'figma@market': [{ scope: 'user', installPath: path.join(cache, '2.2.95'), version: '2.2.95' }] })

      const catalog = await getSkillCatalog('claude')

      expect(catalog.skills).toEqual([{ token: 'figma:figma-use', name: 'figma-use', description: 'CURRENT', source: 'plugin', group: 'figma' }])
    })

    it('prefers a project-scoped install over the user one', async () => {
      const h = home()
      const user = path.join(h, 'u')
      const proj = path.join(h, 'p')
      writeSkill(path.join(user, 'skills'), 'demo-skill', skillMd(['description: from user']))
      writeSkill(path.join(proj, 'skills'), 'demo-skill', skillMd(['description: from project']))
      writeManifest(h, { 'demo@market': [{ scope: 'user', installPath: user }, { scope: 'project', installPath: proj }] })

      expect((await getSkillCatalog('claude')).skills.map(s => s.description)).toEqual(['from project'])
    })

    it('degrades a corrupt manifest, a wrong-shaped one and a hostile plugin key to "no plugin skills"', async () => {
      const h = home()
      writeSkill(path.join(h, '.claude', 'skills'), 'personal-skill')
      const dir = path.join(h, '.claude', 'plugins')
      fs.mkdirSync(dir, { recursive: true })
      for (const text of ['{ not json', '[]', '{"plugins":"x"}', '{"plugins":{"a b@m":[{"installPath":"C:\\\\x"}],"ok@m":"nope"}}']) {
        fs.writeFileSync(path.join(dir, 'installed_plugins.json'), text)
        clearSkillCatalogCache()
        expect(tokens(await getSkillCatalog('claude')), text).toEqual(['personal-skill'])
      }
    })

    it('is a claude-only root: codex has no plugin manifest', async () => {
      const h = home()
      const install = path.join(h, 'plug')
      writeSkill(path.join(install, 'skills'), 'demo-skill')
      writeManifest(h, { 'demo@market': [{ scope: 'user', installPath: install }] })
      expect((await getSkillCatalog('codex')).skills).toEqual([])
    })
  })

  it('reads codex skills from $CODEX_HOME, defaulting to ~/.codex when it is unset or blank', async () => {
    const h = home()
    const codexHome = tmp('skills-codexhome-')
    writeSkill(path.join(codexHome, 'skills'), 'from-codex-home')
    writeSkill(path.join(h, '.codex', 'skills'), 'from-default')

    process.env.CODEX_HOME = codexHome
    expect(tokens(await getSkillCatalog('codex'))).toEqual(['from-codex-home'])

    for (const blank of ['', '   ']) {
      process.env.CODEX_HOME = blank
      clearSkillCatalogCache()
      expect(tokens(await getSkillCatalog('codex')), JSON.stringify(blank)).toEqual(['from-default'])
    }
  })

  it('reads a relative project directory against the server cwd, and lists no project skills without one', async () => {
    home()
    const project = tmp('skills-project-')
    writeSkill(path.join(project, '.codex', 'skills'), 'proj-skill')
    expect(tokens(await getSkillCatalog('codex', path.relative(process.cwd(), project)))).toEqual(['proj-skill'])
    clearSkillCatalogCache()
    expect(tokens(await getSkillCatalog('codex'))).toEqual([])
  })

  describe('limits', () => {
    it(`stops at ${MAX_DIR_ENTRIES_PER_ROOT} directories per root and says how many were left`, async () => {
      const h = home()
      for (let i = 0; i < MAX_DIR_ENTRIES_PER_ROOT + 50; i++) writeSkill(path.join(h, '.claude', 'skills'), `skill-${String(i).padStart(4, '0')}`)
      const catalog = await getSkillCatalog('claude')
      expect(catalog.skills).toHaveLength(MAX_DIR_ENTRIES_PER_ROOT)
      expect(catalog.detail).toContain('50 additional skill folders')
    }, 30_000)

    it(`stops at ${MAX_SKILLS_PER_CATALOG} skills across roots`, async () => {
      const h = home()
      const project = tmp('skills-project-')
      for (let i = 0; i < 150; i++) writeSkill(path.join(project, '.claude', 'skills'), `p-${String(i).padStart(4, '0')}`)
      for (let i = 0; i < 150; i++) writeSkill(path.join(h, '.claude', 'skills'), `u-${String(i).padStart(4, '0')}`)
      const bulk = path.join(h, 'bulk')
      for (let i = 0; i < 100; i++) writeSkill(path.join(bulk, 'skills'), `b-${String(i).padStart(4, '0')}`)
      writeManifest(h, { 'bulk@market': [{ scope: 'user', installPath: bulk }] })

      const catalog = await getSkillCatalog('claude', project)

      expect(catalog.skills).toHaveLength(MAX_SKILLS_PER_CATALOG)
      expect(catalog.detail).toContain(`${MAX_SKILLS_PER_CATALOG}`)
    }, 30_000)

    it('reads an oversized manifest as no plugins', async () => {
      const h = home()
      const dir = path.join(h, '.claude', 'plugins')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'installed_plugins.json'), JSON.stringify({ plugins: {}, pad: 'x'.repeat(1024 * 1024) }))
      expect(await getSkillCatalog('claude')).toMatchObject({ skills: [] })
    })
  })

  it('never lets an absolute path into the serialized catalog', async () => {
    const h = home()
    const project = tmp('skills-project-')
    writeSkill(path.join(project, '.claude', 'skills'), 'proj-skill', skillMd(['description: lives in the project']))
    writeSkill(path.join(h, '.claude', 'skills'), 'personal-skill')
    const install = path.join(h, '.claude', 'plugins', 'cache', 'market', 'demo', '1.0.0')
    writeSkill(path.join(install, 'skills'), 'demo-skill')
    writeManifest(h, { 'demo@market': [{ scope: 'user', installPath: install }] })
    // An unreadable root and a cut-off one put text in `detail`: that must be path-free too.
    for (let i = 0; i < MAX_DIR_ENTRIES_PER_ROOT + 1; i++) fs.mkdirSync(path.join(project, '.codex', 'skills', `d-${i}`), { recursive: true })

    for (const [program, dir] of [['claude', project], ['codex', project]] as const) {
      clearSkillCatalogCache()
      const serialized = JSON.stringify(await getSkillCatalog(program, dir))
      for (const secret of [h, project, install, h.replace(/\\/g, '/'), project.replace(/\\/g, '/'), os.tmpdir()]) {
        expect(serialized, program).not.toContain(secret)
      }
    }
    // Not vacuous: the claude scan did list the three entries.
    clearSkillCatalogCache()
    expect((await getSkillCatalog('claude', project)).skills).toHaveLength(3)
  }, 30_000)

  describe('cache', () => {
    it('serves a scan for the TTL and rescans after it is cleared', async () => {
      const h = home()
      const root = path.join(h, '.claude', 'skills')
      writeSkill(root, 'first')
      expect(tokens(await getSkillCatalog('claude'))).toEqual(['first'])
      writeSkill(root, 'second')
      expect(tokens(await getSkillCatalog('claude'))).toEqual(['first'])
      clearSkillCatalogCache()
      expect(tokens(await getSkillCatalog('claude'))).toEqual(['first', 'second'])
    })

    it('rescans once the TTL has passed', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      try {
        const h = home()
        const root = path.join(h, '.claude', 'skills')
        writeSkill(root, 'first')
        await getSkillCatalog('claude')
        writeSkill(root, 'second')
        vi.advanceTimersByTime(61_000)
        expect(tokens(await getSkillCatalog('claude'))).toEqual(['first', 'second'])
      } finally {
        vi.useRealTimers()
      }
    })

    it('is keyed by project directory, so two worktrees do not share a catalog', async () => {
      home()
      const a = tmp('skills-a-')
      const b = tmp('skills-b-')
      writeSkill(path.join(a, '.claude', 'skills'), 'only-in-a')
      writeSkill(path.join(b, '.claude', 'skills'), 'only-in-b')
      expect(tokens(await getSkillCatalog('claude', a))).toEqual(['only-in-a'])
      expect(tokens(await getSkillCatalog('claude', b))).toEqual(['only-in-b'])
    })

    it(`holds at most ${MAX_CACHED_CATALOGS} catalogs`, async () => {
      home()
      const spy = vi.spyOn(fs, 'realpathSync')
      const dirs = Array.from({ length: MAX_CACHED_CATALOGS + 5 }, (_, i) => path.join(os.tmpdir(), `skills-nonexistent-${i}`))
      for (const dir of dirs) await getSkillCatalog('claude', dir)
      spy.mockClear()
      await getSkillCatalog('claude', dirs[0]) // evicted: scanned again
      expect(spy).toHaveBeenCalled()
      spy.mockClear()
      await getSkillCatalog('claude', dirs[dirs.length - 1]) // newest: still cached
      expect(spy).not.toHaveBeenCalled()
    })
  })

  describe('symlink containment', () => {
    it('skips a skill whose directory junction resolves outside the root', async () => {
      const h = home()
      const outside = tmp('skills-outside-')
      writeSkill(outside, 'escaped-skill', skillMd(['description: must not be listed']))
      const root = path.join(h, '.claude', 'skills')
      writeSkill(root, 'honest-skill')
      try {
        fs.symlinkSync(path.join(outside, 'escaped-skill'), path.join(root, 'escaped-skill'), 'junction')
      } catch {
        return // a host that cannot create junctions has nothing to assert
      }
      expect(tokens(await getSkillCatalog('claude'))).toEqual(['honest-skill'])
    })
  })
})
