import fs from 'fs'
import path from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { EnsembleTeam } from '../src/types'
import { bootServer } from './helpers/boot-server'

describe('server boot cleanup', () => {
  let server: Awaited<ReturnType<typeof bootServer>>

  beforeAll(async () => {
    const base = { description: 'd', agents: [], createdBy: 'u', feedMode: 'live' as const }
    const seeded: EnsembleTeam[] = [
      { ...base, id: 'recent-active', name: 'a', status: 'active', createdAt: new Date().toISOString() },
      { ...base, id: 'old-active', name: 'b', status: 'active', createdAt: '2020-01-01T00:00:00.000Z' },
      { ...base, id: 'stuck-forming', name: 'c', status: 'forming', createdAt: new Date().toISOString() },
      { ...base, id: 'finished', name: 'd', status: 'disbanded', createdAt: '2020-01-01T00:00:00.000Z', completedAt: '2020-01-02T00:00:00.000Z' },
    ]
    server = await bootServer({
      seed: root => {
        fs.mkdirSync(path.join(root, 'ensemble'), { recursive: true })
        fs.writeFileSync(path.join(root, 'ensemble', 'teams.json'), JSON.stringify(seeded))
      },
    })
  })

  afterAll(() => {
    server.restore()
    server.cleanup()
  })

  it('serves every team that was active or forming as disbanded, however recent', async () => {
    const { teams } = await (await fetch(`${server.baseUrl}/api/ensemble/teams`)).json() as { teams: EnsembleTeam[] }
    const byId = Object.fromEntries(teams.map(t => [t.id, t]))

    for (const id of ['recent-active', 'old-active', 'stuck-forming']) {
      expect(byId[id]).toMatchObject({ status: 'disbanded', completedAt: expect.any(String) })
    }
    expect(byId['finished'].completedAt).toBe('2020-01-02T00:00:00.000Z')
  })

  it('persists the cleanup so the next start finds nothing to do', async () => {
    const store = await server.store()
    store.flushStore()
    const onDisk = JSON.parse(fs.readFileSync(path.join(server.tempRoot, 'ensemble', 'teams.json'), 'utf8')) as EnsembleTeam[]
    expect(onDisk.map(t => t.status)).toEqual(['disbanded', 'disbanded', 'disbanded', 'disbanded'])
    expect(store.disbandLiveTeamsOnBoot()).toBe(0)
  })
})
