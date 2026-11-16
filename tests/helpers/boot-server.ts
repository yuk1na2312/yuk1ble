import fs from 'fs'
import net from 'net'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { vi } from 'vitest'

/** Three fake-able programs (codex, claude, plain) whose ready marker is the stub screen ">". */
export const FIXTURE_AGENTS_CONFIG = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'agents.json')

/**
 * Boots the real server.ts on an ephemeral port with a temp data dir, real store
 * and real HTTP routes. Only the things that would start real agent CLIs are
 * replaced: the spawner and the PTY runtime. The server keeps listening until
 * its test worker exits, like the onboarding smoke test.
 */

async function getFreePort(): Promise<number> {
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

export async function freeClosedPort(): Promise<number> {
  return getFreePort()
}

export async function bootServer(options: { seed?: (dataRoot: string) => void } = {}) {
  const saved = { ...process.env }
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-server-'))
  const port = await getFreePort()
  const baseUrl = `http://127.0.0.1:${port}`

  process.env.ENSEMBLE_DATA_DIR = tempRoot
  process.env.ENSEMBLE_RUNTIME_DIR = path.join(tempRoot, 'runtime')
  process.env.ENSEMBLE_PORT = String(port)
  process.env.ENSEMBLE_URL = baseUrl
  process.env.ENSEMBLE_AGENTS_CONFIG = FIXTURE_AGENTS_CONFIG

  // Listener registries behind onData/onExit, so a test can push PTY output into a stream and
  // count what is still subscribed once the clients are gone.
  const dataListeners = new Map<string, Set<(chunk: string) => void>>()
  const exitListeners = new Map<string, Set<() => void>>()
  const subscribe = <T>(registry: Map<string, Set<T>>, session: string, listener: T): (() => void) => {
    const set = registry.get(session) ?? new Set<T>()
    registry.set(session, set)
    set.add(listener)
    return () => { set.delete(listener) }
  }
  const countListeners = (): number =>
    [...dataListeners.values(), ...exitListeners.values()].reduce((total, set) => total + set.size, 0)

  const runtime = {
    screen: vi.fn((_session: string, _lines?: number) => '>'),
    sendKeys: vi.fn((_session: string, _keys: string, _opts?: { literal?: boolean; enter?: boolean }) => {}),
    paste: vi.fn((_session: string, _text: string) => {}),
    write: vi.fn((_session: string, _data: string) => {}),
    resize: vi.fn((_session: string, _cols: number, _rows: number) => {}),
    exists: vi.fn((_session: string) => true),
    replay: vi.fn((_session: string) => ''),
    onData: vi.fn((session: string, listener: (chunk: string) => void) => subscribe(dataListeners, session, listener)),
    onExit: vi.fn((session: string, listener: () => void) => subscribe(exitListeners, session, listener)),
  }
  /** What a real session does: PTY output reaches every data listener, and ending drops them all. */
  const pty = {
    emit: (session: string, chunk: string) => {
      for (const listener of [...(dataListeners.get(session) ?? [])]) listener(chunk)
    },
    end: (session: string) => {
      const listeners = [...(exitListeners.get(session) ?? [])]
      dataListeners.delete(session)
      exitListeners.delete(session)
      for (const listener of listeners) listener()
    },
    listenerCount: countListeners,
  }
  const spawnLocalAgent = vi.fn(async ({ name }: { name: string }) => ({ id: `${name}-id` }))

  options.seed?.(tempRoot)

  vi.resetModules()
  vi.doMock('../../lib/agent-spawner', () => ({
    spawnLocalAgent,
    killLocalAgent: vi.fn(async () => {}),
    getAgentTokenUsage: vi.fn(async () => 'unknown'),
  }))
  vi.doMock('../../lib/agent-runtime', () => ({
    getRuntime: vi.fn(() => runtime),
    setRuntime: vi.fn(),
  }))

  await import('../../server')

  const startedAt = Date.now()
  for (;;) {
    try {
      if ((await fetch(`${baseUrl}/api/v1/health`)).ok) break
    } catch { /* still starting */ }
    if (Date.now() - startedAt > 5000) throw new Error(`Server did not become healthy at ${baseUrl}`)
    await new Promise(resolve => setTimeout(resolve, 100))
  }

  return {
    baseUrl,
    tempRoot,
    runtime,
    pty,
    spawnLocalAgent,
    /** The same store module instance the running server uses. */
    store: () => import('../../lib/ensemble-registry'),
    restore: () => {
      process.env = saved
      vi.resetModules()
      vi.restoreAllMocks()
    },
    cleanup: () => fs.rmSync(tempRoot, { recursive: true, force: true }),
  }
}
