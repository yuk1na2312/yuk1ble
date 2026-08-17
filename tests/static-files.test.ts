import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * resolveStaticFile() / staticContentType() — server.ts's containment +
 * extension-allowlist gate for serving the whole public/ tree (design doc:
 * see the "Requirements for the handler" section of the integration
 * contract for this redesign).
 *
 * Both helpers are pure path arithmetic with no filesystem access, so they
 * are testable without fixtures — deliberately, since public/js/*.js and
 * public/app.css are being written concurrently by other agents while this
 * test runs and must not be depended on.
 *
 * Importing server.ts still runs its module-level side effects (PtyRuntime
 * wiring, log capture, SIGINT/SIGTERM/exit handlers, and a real
 * `http.Server.listen()` call) — the same trade-off tests/team-removal.test.ts
 * accepts for services/ensemble-service.ts. ENSEMBLE_PORT is pinned to `0` so
 * the OS assigns a free ephemeral port; the server is never actually queried
 * over HTTP here, so which port it landed on doesn't matter, and it can never
 * collide with a real `npm run dev` or another agent's test run.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PUBLIC_DIR = path.join(REPO_ROOT, 'public')

describe('resolveStaticFile() / staticContentType()', () => {
  const originalEnv = {
    port: process.env.ENSEMBLE_PORT,
    dataDir: process.env.ENSEMBLE_DATA_DIR,
    runtimeDir: process.env.ENSEMBLE_RUNTIME_DIR,
  }
  let dataDir: string
  let runtimeDir: string

  // Importing server.ts transitively imports services/ensemble-service.ts
  // and lib/pty-runtime.ts, both of which register process-level SIGINT /
  // SIGTERM / exit handlers as an unconditional side effect of being loaded.
  // Diff and strip whatever this file's single import adds, same idiom as
  // tests/team-removal.test.ts, so nothing leaks into other test files that
  // happen to share this worker.
  const sigintBefore = process.listeners('SIGINT')
  const sigtermBefore = process.listeners('SIGTERM')
  const beforeExitBefore = process.listeners('beforeExit')
  const exitBefore = process.listeners('exit')

  let resolveStaticFile: (urlPath: string) => string | null
  let staticContentType: (filePath: string) => string

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-static-data-'))
    runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-static-runtime-'))
    process.env.ENSEMBLE_DATA_DIR = dataDir
    process.env.ENSEMBLE_RUNTIME_DIR = runtimeDir
    process.env.ENSEMBLE_PORT = '0'

    const server = await import('../server')
    resolveStaticFile = server.resolveStaticFile
    staticContentType = server.staticContentType
  })

  afterAll(() => {
    for (const listener of process.listeners('SIGINT')) {
      if (!sigintBefore.includes(listener)) process.removeListener('SIGINT', listener)
    }
    for (const listener of process.listeners('SIGTERM')) {
      if (!sigtermBefore.includes(listener)) process.removeListener('SIGTERM', listener)
    }
    for (const listener of process.listeners('beforeExit')) {
      if (!beforeExitBefore.includes(listener)) process.removeListener('beforeExit', listener)
    }
    for (const listener of process.listeners('exit')) {
      if (!exitBefore.includes(listener)) process.removeListener('exit', listener)
    }

    if (originalEnv.port === undefined) delete process.env.ENSEMBLE_PORT
    else process.env.ENSEMBLE_PORT = originalEnv.port
    if (originalEnv.dataDir === undefined) delete process.env.ENSEMBLE_DATA_DIR
    else process.env.ENSEMBLE_DATA_DIR = originalEnv.dataDir
    if (originalEnv.runtimeDir === undefined) delete process.env.ENSEMBLE_RUNTIME_DIR
    else process.env.ENSEMBLE_RUNTIME_DIR = originalEnv.runtimeDir

    fs.rmSync(dataDir, { recursive: true, force: true })
    fs.rmSync(runtimeDir, { recursive: true, force: true })
  })

  // ── happy paths ──────────────────────────────────────────────────────

  it('/ resolves to public/index.html', () => {
    expect(resolveStaticFile('/')).toBe(path.join(PUBLIC_DIR, 'index.html'))
  })

  it('/index.html resolves to the same file as /', () => {
    expect(resolveStaticFile('/index.html')).toBe(path.join(PUBLIC_DIR, 'index.html'))
  })

  it('resolves a top-level .css file', () => {
    expect(resolveStaticFile('/app.css')).toBe(path.join(PUBLIC_DIR, 'app.css'))
  })

  it('resolves a nested .js file (js/app.js)', () => {
    expect(resolveStaticFile('/js/app.js')).toBe(path.join(PUBLIC_DIR, 'js', 'app.js'))
  })

  it('resolves another nested .js file (js/dom.js)', () => {
    expect(resolveStaticFile('/js/dom.js')).toBe(path.join(PUBLIC_DIR, 'js', 'dom.js'))
  })

  it('resolves a nested vendored .js file (vendor/motion.dom.js)', () => {
    expect(resolveStaticFile('/vendor/motion.dom.js')).toBe(path.join(PUBLIC_DIR, 'vendor', 'motion.dom.js'))
  })

  it('resolves a .svg file', () => {
    expect(resolveStaticFile('/icon.svg')).toBe(path.join(PUBLIC_DIR, 'icon.svg'))
  })

  it('resolves a nested .woff2 file', () => {
    expect(resolveStaticFile('/fonts/foo.woff2')).toBe(path.join(PUBLIC_DIR, 'fonts', 'foo.woff2'))
  })

  // ── traversal attacks ───────────────────────────────────────────────

  it('rejects ../ traversal to a file outside public/', () => {
    expect(resolveStaticFile('/../server.ts')).toBeNull()
  })

  it('rejects a deeper ../ traversal', () => {
    expect(resolveStaticFile('/js/../../server.ts')).toBeNull()
  })

  it('rejects ..\\ (backslash) traversal', () => {
    expect(resolveStaticFile('/js\\..\\..\\server.ts')).toBeNull()
  })

  it('rejects a leading ..\\ traversal', () => {
    expect(resolveStaticFile('\\..\\server.ts')).toBeNull()
  })

  it('rejects percent-encoded ../ traversal (%2e%2e%2f)', () => {
    expect(resolveStaticFile('/%2e%2e%2fserver.ts')).toBeNull()
  })

  it('rejects a percent-encoded traversal reaching further up the tree', () => {
    expect(resolveStaticFile('/js/%2e%2e/%2e%2e/server.ts')).toBeNull()
  })

  it('does not escape public/ on a double-encoded traversal payload', () => {
    // decodeURIComponent runs exactly once, so %252e%252e%252f decodes to
    // the literal string "%2e%2e%2f" — not "..\/" — and is therefore never
    // interpreted as a path separator. It's rejected (here, because the
    // resulting filename ends in .ts, which isn't allowlisted) but the
    // load-bearing property is that IF it were ever accepted, it must still
    // resolve inside PUBLIC_DIR.
    const result = resolveStaticFile('/%252e%252e%252fserver.ts')
    if (result !== null) {
      expect(result === PUBLIC_DIR || result.startsWith(PUBLIC_DIR + path.sep)).toBe(true)
    }
    expect(result).toBeNull()
  })

  it('rejects an absolute Windows path escape, even with an allowlisted extension', () => {
    expect(resolveStaticFile('/C:/Windows/evil.html')).toBeNull()
  })

  it('rejects an absolute Windows path escape spelled with backslashes', () => {
    expect(resolveStaticFile('C:\\Windows\\evil.html')).toBeNull()
  })

  // ── extension allowlist ─────────────────────────────────────────────

  it('rejects a disallowed extension that exists on disk (server.ts itself)', () => {
    // Both a traversal (escapes public/) and a disallowed extension (.ts) —
    // either gate alone would already refuse this.
    expect(resolveStaticFile('/../server.ts')).toBeNull()
  })

  it('rejects a disallowed extension inside public/ (hypothetical public/foo.json)', () => {
    // Contained within PUBLIC_DIR — only the extension gate refuses this.
    const result = resolveStaticFile('/foo.json')
    expect(result).toBeNull()
  })

  it('rejects a disallowed extension on a real vendored file (.LICENSE.md)', () => {
    expect(resolveStaticFile('/vendor/motion.LICENSE.md')).toBeNull()
  })

  // ── directory paths ─────────────────────────────────────────────────

  it('rejects a bare directory path with no extension', () => {
    expect(resolveStaticFile('/js')).toBeNull()
  })

  it('rejects a bare directory path with a trailing slash', () => {
    expect(resolveStaticFile('/vendor/')).toBeNull()
  })

  // ── malformed input ─────────────────────────────────────────────────

  it('rejects a malformed percent-escape instead of throwing', () => {
    expect(() => resolveStaticFile('/%')).not.toThrow()
    expect(resolveStaticFile('/%')).toBeNull()
  })

  it('rejects a truncated percent-escape instead of throwing', () => {
    expect(() => resolveStaticFile('/js/app%2.js')).not.toThrow()
    expect(resolveStaticFile('/js/app%2.js')).toBeNull()
  })

  // ── content-type mapping ────────────────────────────────────────────

  it('maps every allowlisted extension to a charset=utf-8 text content-type, except woff2', () => {
    expect(staticContentType(path.join(PUBLIC_DIR, 'index.html'))).toBe('text/html; charset=utf-8')
    expect(staticContentType(path.join(PUBLIC_DIR, 'app.css'))).toBe('text/css; charset=utf-8')
    expect(staticContentType(path.join(PUBLIC_DIR, 'js', 'app.js'))).toBe('application/javascript; charset=utf-8')
    expect(staticContentType(path.join(PUBLIC_DIR, 'icon.svg'))).toBe('image/svg+xml; charset=utf-8')
    expect(staticContentType(path.join(PUBLIC_DIR, 'fonts', 'foo.woff2'))).toBe('font/woff2')
  })

  // ── GET /api/ensemble/skills vs. the static fallback ───────────────
  //
  // Design doc (2026-08-16-agent-skill-invocation-design.md) §5 / §11:
  // "/api/ensemble/skills resolves before the static fallback and cannot be
  // shadowed by a public/ file of the same path." The route itself lives in
  // the request handler (not exported, matching the rest of this file's
  // no-live-request convention — see the file header), so it is verified
  // two ways that together prove the property without an HTTP round trip:
  //
  //   1. resolveStaticFile() — the exact gate the static fallback branch
  //      uses — can never resolve this literal path to a file in the first
  //      place, because it carries no allowlisted extension. No public/
  //      file, however named, can ever be reached at this URL.
  //   2. The route registration for '/api/ensemble/skills' appears in
  //      server.ts's source strictly before the static-fallback branch
  //      (the resolveStaticFile(path) call at the bottom of the handler).
  //      Every branch above it in that sequential if-chain returns before
  //      falling through, so source order here is control-flow order.
  describe('GET /api/ensemble/skills vs. the static fallback', () => {
    const serverSource = fs.readFileSync(path.join(REPO_ROOT, 'server.ts'), 'utf-8')

    it('can never be resolved as a static file — the path has no allowlisted extension', () => {
      expect(resolveStaticFile('/api/ensemble/skills')).toBeNull()
    })

    it('is registered in server.ts strictly before the static-file fallback', () => {
      // Built by concatenation, not as one string literal, so this assertion
      // cannot pass vacuously against a comment that merely mentions the
      // route without server.ts actually registering it.
      const routeNeedle = "'" + '/api/ensemble/skills' + "'"
      const fallbackNeedle = 'resolveStaticFile' + '(path)'

      const routeIndex = serverSource.indexOf(routeNeedle)
      const fallbackIndex = serverSource.indexOf(fallbackNeedle)

      expect(routeIndex).toBeGreaterThan(-1)
      expect(fallbackIndex).toBeGreaterThan(-1)
      expect(routeIndex).toBeLessThan(fallbackIndex)
    })
  })
})
