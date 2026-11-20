import { execFile, execFileSync } from 'child_process'
import { randomUUID } from 'crypto'
import fs from 'fs'
import net from 'net'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { EnsembleMessage, EnsembleTeam } from '../src/types'

/**
 * The whole stack with a fake agent CLI (tests/fixtures/fake-agent.mjs): the real server, the real
 * ConPTY runtime, real readiness and delivery, real SSE streams, real process trees. Nothing here
 * ever starts a real agent. Timeouts are generous but every wait is bounded.
 */

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const FAKE_AGENT = path.join(REPO_ROOT, 'tests', 'fixtures', 'fake-agent.mjs')
const FIXTURE_CONFIG = path.join(REPO_ROOT, 'tests', 'fixtures', 'fake-agents.json')

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

async function until<T>(what: string, probe: () => T | undefined | false | Promise<T | undefined | false>, timeoutMs = 45_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}`)
    await sleep(200)
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address()
      if (!address || typeof address === 'string') return reject(new Error('no port'))
      srv.close(err => (err ? reject(err) : resolve(address.port)))
    })
    srv.on('error', reject)
  })
}

interface WinProcess { ProcessId: number; ParentProcessId: number; Name: string; CommandLine: string | null }

/** Every process on the machine, via PowerShell (there is no portable way to ask for command lines). */
function listProcesses(): Promise<WinProcess[]> {
  const script = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress'
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err)
      const parsed = JSON.parse(stdout) as WinProcess | WinProcess[]
      resolve(Array.isArray(parsed) ? parsed : [parsed])
    })
  })
}

/** A minimal SSE reader over fetch: collects events and lets a test wait for one. */
function openSse(url: string) {
  const controller = new AbortController()
  const events: Array<{ event: string; data: string }> = []
  let opened!: () => void
  const ready = new Promise<void>(resolve => { opened = resolve })
  const done = (async () => {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok || !res.body) throw new Error(`SSE ${url} answered ${res.status}`)
    opened()
    const decoder = new TextDecoder()
    let buffer = ''
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true })
      let at: number
      while ((at = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, at)
        buffer = buffer.slice(at + 2)
        const event = /^event: (.*)$/m.exec(block)?.[1]
        const data = /^data: (.*)$/m.exec(block)?.[1]
        if (event && data !== undefined) events.push({ event, data })
      }
    }
  })().catch(() => { /* aborted on close */ })
  return {
    events,
    ready,
    close: () => { controller.abort() },
    done,
    find: (predicate: (e: { event: string; data: string }) => boolean) => events.find(predicate),
  }
}

describe('a team of fake agents, end to end', () => {
  const saved = { ...process.env }
  const tag = `ensemble-e2e-${randomUUID()}`
  let root: string
  let baseUrl: string
  const streams: Array<{ close: () => void }> = []
  let teamId: string | undefined

  const api = async <T>(method: string, route: string, body?: unknown): Promise<{ status: number; body: T }> => {
    const res = await fetch(`${baseUrl}${route}`, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: res.status, body: await res.json() as T }
  }
  const pane = async (session: string): Promise<string> =>
    (await api<{ pane: string }>('GET', `/api/ensemble/sessions/${encodeURIComponent(session)}/pane?lines=300`)).body.pane
  const decode = (b64: string): string => Buffer.from(b64, 'base64').toString('utf8')

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-e2e-'))
    // The fixture's relative script path becomes absolute, and every launch carries a unique tag so the
    // processes of this run (and only this run) can be found by command line afterwards.
    const config = JSON.parse(fs.readFileSync(FIXTURE_CONFIG, 'utf8')) as Record<string, { flags: string[] }>
    for (const program of Object.values(config)) program.flags = [FAKE_AGENT, `--tag=${tag}`]
    const configFile = path.join(root, 'agents.json')
    fs.writeFileSync(configFile, JSON.stringify(config))

    const port = await freePort()
    baseUrl = `http://127.0.0.1:${port}`
    Object.assign(process.env, {
      ENSEMBLE_DATA_DIR: path.join(root, 'data'),
      ENSEMBLE_RUNTIME_DIR: path.join(root, 'runtime'),
      ENSEMBLE_PORT: String(port),
      ENSEMBLE_URL: baseUrl,
      ENSEMBLE_AGENTS_CONFIG: configFile,
      ENSEMBLE_READY_TIMEOUT_MS: '60000',
    })

    vi.resetModules()
    await import('../src/server/index')
    await until('the server to answer', async () => {
      try { return (await fetch(`${baseUrl}/api/v1/health`)).ok } catch { return false }
    }, 15_000)
  }, 30_000)

  afterAll(async () => {
    for (const stream of streams) stream.close()
    try {
      // Even when a check failed half way: end the team, then make sure nothing tagged survives.
      if (teamId) await fetch(`${baseUrl}/api/ensemble/teams/${teamId}/disband`, { method: 'POST' }).catch(() => undefined)
      const leftovers = (await listProcesses()).filter(p => p.CommandLine?.includes(tag))
      for (const p of leftovers) {
        try { execFileSync('taskkill', ['/T', '/F', '/PID', String(p.ProcessId)], { stdio: 'ignore' }) } catch { /* gone */ }
      }
    } finally {
      process.env = saved
      vi.resetModules()
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)

  it('starts two agents, delivers prompts and messages, streams and accepts input, and leaves no process behind on disband', async () => {
    // The catalog lists the fixture programs, installed.
    const programs = (await api<Array<{ name: string; installed: boolean }>>('GET', '/api/ensemble/programs')).body
    expect(programs.map(p => [p.name, p.installed])).toEqual([['fakea', true], ['fakeb', true]])

    // Push stream first, so no event is missed.
    const events = openSse(`${baseUrl}/api/ensemble/events`)
    streams.push(events)
    await events.ready

    // A team name with a space: the session names come from one function (regression).
    const created = await api<{ team: EnsembleTeam }>('POST', '/api/ensemble/teams', {
      name: 'e2e team',
      description: 'Say hello to your teammate.',
      agents: [{ program: 'fakea' }, { program: 'fakeb', model: 'm1' }],
      workingDirectory: root,
    })
    expect(created.status).toBe(202)
    const team = created.body.team
    teamId = team.id
    const sessions = team.agents.map(a => a.sessionName as string)
    expect(sessions).toEqual(['e2eteam-fakea-1', 'e2eteam-fakeb-2'])

    // Both agents become ready and receive their startup prompt: the fake echoes what it was given.
    for (const [i, session] of sessions.entries()) {
      const name = team.agents[i].name
      const screen = await until(`${session} to echo its startup prompt`, async () => {
        const text = await pane(session)
        return text.includes('FAKE AGENT READY >') && text.includes(`got: You are ${name} in team`) ? text : undefined
      }, 60_000)
      expect(screen).toContain('fake agent started')
    }
    await until('the team to report both agents prompted', async () => {
      const feed = (await api<{ messages: EnsembleMessage[] }>('GET', `/api/ensemble/teams/${team.id}/feed`)).body.messages
      return feed.some(m => /2 agents received their task/.test(m.content)) ? true : undefined
    }, 30_000)
    expect((await api<{ team: EnsembleTeam }>('GET', `/api/ensemble/teams/${team.id}`)).body.team.status).toBe('active')

    // A user message reaches both terminals.
    const posted = await api('POST', `/api/ensemble/teams/${team.id}`, { to: 'team', from: 'user', content: 'hello from the e2e test' })
    expect(posted.status).toBe(200)
    for (const session of sessions) {
      await until(`${session} to receive the team message`, async () =>
        (await pane(session)).includes('got: [Team message from user]: hello from the e2e test') || undefined, 45_000)
    }

    // The events stream carried the team and the message.
    const teamEvents = events.events.filter(e => e.event === 'team').map(e => JSON.parse(e.data) as EnsembleTeam)
    expect(teamEvents.some(t => t.id === team.id && t.status === 'forming')).toBe(true)
    expect(teamEvents.some(t => t.id === team.id && t.status === 'active')).toBe(true)
    const messageEvents = events.events.filter(e => e.event === 'message').map(e => JSON.parse(e.data) as EnsembleMessage)
    const hello = messageEvents.find(m => m.content === 'hello from the e2e test')
    expect(hello).toMatchObject({ teamId: team.id, from: 'user', to: 'team' })
    expect(hello?.seq).toEqual(expect.any(Number))

    // A skill installed in the team's working directory is listed, and firing it types the command, then the nudge, into the right terminal only.
    const skillDir = path.join(root, '.fake', 'skills', 'greet')
    fs.mkdirSync(skillDir, { recursive: true })
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: greet\ndescription: Say hello.\n---\nBody')
    const catalog = await api<{ invocation: string; skills: Array<{ token: string }> }>('GET', `/api/ensemble/skills?team=${team.id}&agent=${team.agents[0].name}`)
    expect(catalog.body).toMatchObject({ invocation: 'slash', skills: [{ token: 'greet' }] })
    expect(JSON.stringify(catalog.body)).not.toContain(root)
    const fired = await api<{ message: EnsembleMessage }>('POST', `/api/ensemble/teams/${team.id}/skill`, { agent: team.agents[0].name, token: 'greet', args: 'from the e2e test' })
    expect(fired.status).toBe(200)
    expect(fired.body.message).toMatchObject({ type: 'command', to: team.agents[0].name, content: '/greet from the e2e test' })
    await until('the agent to receive the command and then the nudge', async () => {
      const text = await pane(sessions[0])
      const command = text.indexOf('got: /greet from the e2e test')
      return command >= 0 && text.indexOf('got: → When you', command) > command ? true : undefined
    }, 45_000)
    expect(await pane(sessions[1])).not.toContain('/greet')
    const commands = (await api<{ messages: EnsembleMessage[] }>('GET', `/api/ensemble/teams/${team.id}/feed`)).body.messages.filter(m => m.type === 'command')
    expect(commands).toHaveLength(1)

    // A session stream: scrollback replay first, then live bytes; input typed into it is echoed.
    const stream = openSse(`${baseUrl}/api/ensemble/sessions/${sessions[0]}/stream`)
    streams.push(stream)
    await until('the replay event', () => stream.events.length > 0 || undefined, 15_000)
    expect(stream.events[0].event).toBe('replay')
    expect(decode(stream.events[0].data)).toContain('FAKE AGENT READY >')
    const typed = await api('POST', `/api/ensemble/sessions/${sessions[0]}/input`, { data: 'typed-through-input\r' })
    expect(typed.status).toBe(200)
    // Raw bytes concatenated before decoding, as the browser does: a multi-byte character may span chunks.
    const live = (): string => Buffer.concat(stream.events.slice(1).filter(e => e.event === 'data').map(e => Buffer.from(e.data, 'base64'))).toString('utf8')
    await until('the echo of typed input on the stream', () => live().includes('got: typed-through-input') || undefined, 30_000)
    expect(stream.events.slice(1).every(e => e.event === 'data' || e.event === 'exit')).toBe(true)

    // Record the process trees, then disband.
    const before = (await listProcesses()).filter(p => p.CommandLine?.includes(tag))
    expect(before.length).toBeGreaterThanOrEqual(2) // one fake agent per session
    const shells = new Set<number>()
    const all = await listProcesses()
    for (const proc of before) {
      const parent = all.find(p => p.ProcessId === proc.ParentProcessId)
      if (parent && /^(pwsh|powershell)\.exe$/i.test(parent.Name)) shells.add(parent.ProcessId)
    }
    const watched = new Set([...before.map(p => p.ProcessId), ...shells])
    expect(shells.size).toBe(2)

    const disbanded = await api<{ team: EnsembleTeam }>('POST', `/api/ensemble/teams/${team.id}/disband`, {})
    expect(disbanded.status).toBe(200)
    expect(disbanded.body.team.status).toBe('disbanded')
    await until('the disbanded team event', () => events.find(e => e.event === 'team' && (JSON.parse(e.data) as EnsembleTeam).status === 'disbanded'), 15_000)
    await until('the session stream to end with exit', () => stream.events.some(e => e.event === 'exit') || undefined, 15_000)
    // The terminal is gone for good.
    expect((await api('POST', `/api/ensemble/sessions/${sessions[0]}/input`, { data: 'x' })).status).toBe(404)

    // No process of the run survives: not the fake agents, not the shells that hosted them.
    await until('every process of the run to be gone', async () => {
      const alive = new Set((await listProcesses()).map(p => p.ProcessId))
      return [...watched].every(pid => !alive.has(pid)) || undefined
    }, 30_000)
  }, 240_000)
})
