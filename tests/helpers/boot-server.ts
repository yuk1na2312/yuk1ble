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

  const runtime = {
    capturePane: vi.fn(async (_session: string, _lines?: number) => '>'),
    sendKeys: vi.fn(async (_session: string, _keys: string, _opts?: { literal?: boolean; enter?: boolean }) => {}),
    pasteFromFile: vi.fn(async (_session: string, _file: string) => {}),
    sessionExists: vi.fn(async (_session: string) => true),
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
