import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { bootServer, FIXTURE_AGENTS_CONFIG } from './helpers/boot-server'
import { clearAgentsConfigCache } from '../lib/agent-config'
import { PROGRAMS_CACHE_MS, clearProgramsCache, describePrograms } from '../lib/programs'

describe('GET /api/ensemble/programs', () => {
  let server: Awaited<ReturnType<typeof bootServer>>
  beforeAll(async () => { server = await bootServer() })
  afterAll(() => { server.restore(); server.cleanup() })

  it('lists every adapter with name, icon, colour, models and installed', async () => {
    const res = await fetch(`${server.baseUrl}/api/ensemble/programs`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    const programs = await res.json() as Array<Record<string, unknown>>

    expect(programs.map(p => p.name)).toEqual(['codex', 'claude', 'plain'])
    for (const program of programs) {
      expect(Object.keys(program).sort()).toEqual(['color', 'icon', 'installed', 'models', 'name'])
      expect(typeof program.installed).toBe('boolean')
    }
    expect(programs[0]).toMatchObject({ icon: '◆', color: '#6aa9ff', models: [{ id: 'gpt-5.6-sol', label: 'Sol' }] })
    expect((programs[1].models as Array<{ id: string }>).map(m => m.id)).toEqual(['fable', 'opus', 'sonnet'])
    expect(programs[2].models).toEqual([])
  })

  it('is matched ahead of the static page and exposes nothing but the catalog', async () => {
    const programs = JSON.stringify(await (await fetch(`${server.baseUrl}/api/ensemble/programs`)).json())
    expect(programs).not.toContain('flags')
    expect(programs).not.toContain('gates')
    const page = await fetch(`${server.baseUrl}/`)
    expect(page.headers.get('content-type')).toContain('text/html')
  })
})

describe('installed', () => {
  let bin: string
  const saved = { path: process.env.PATH, config: process.env.ENSEMBLE_AGENTS_CONFIG }

  beforeEach(() => {
    bin = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-bin-'))
    process.env.PATH = bin
    process.env.ENSEMBLE_AGENTS_CONFIG = FIXTURE_AGENTS_CONFIG
    clearAgentsConfigCache()
    clearProgramsCache()
  })
  afterEach(() => {
    if (saved.path === undefined) delete process.env.PATH
    else process.env.PATH = saved.path
    if (saved.config === undefined) delete process.env.ENSEMBLE_AGENTS_CONFIG
    else process.env.ENSEMBLE_AGENTS_CONFIG = saved.config
    clearAgentsConfigCache()
    clearProgramsCache()
    fs.rmSync(bin, { recursive: true, force: true })
  })

  const installedNames = (now: number) => describePrograms(now).filter(p => p.installed).map(p => p.name)

  it('follows PATH, and the answer is cached for about 30 s', () => {
    expect(installedNames(1_000)).toEqual([])

    fs.writeFileSync(path.join(bin, 'plain.cmd'), '@echo off\r\n')
    expect(installedNames(1_000 + PROGRAMS_CACHE_MS - 1)).toEqual([]) // still the cached answer
    expect(installedNames(1_000 + PROGRAMS_CACHE_MS)).toEqual(['plain'])
  })
})
