/**
 * Regression tests for agent startup readiness.
 *
 * Both screens below are verbatim `screen` output from a real Codex
 * v0.147 session launched through PtyRuntime. The bug they pin: Codex's
 * readyMarker used to be "›", which is also the selection cursor on its
 * "Hooks need review" startup gate — so ensemble reported "codex-1 is ready
 * (3s)" against a modal that was blocking startup, then pasted the prompt
 * into a CLI that never had an input prompt.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { resolveReadyMarkers, clearAgentsConfigCache } from '../lib/agent-config'
import { matchReadyMarker, endsAtShellPrompt, isQuiescentReady } from '../lib/pane-readiness'
import type { EnsembleTeam } from '../types/ensemble'
import {
  CLAUDE_READY_SCREEN, CLAUDE_TRUST_SCREEN, CODEX_HOOKS_GATE_SCREEN, CODEX_READY_SCREEN, POWERSHELL_PROMPT_SCREEN,
} from './fixtures/screens'

/** createEnsembleTeam answers 202 at once; startup then runs on, and `completion` is its end. */
async function createAndWait(mod: typeof import('../services/ensemble-service'), request: unknown) {
  const result = await mod.createEnsembleTeam(request)
  expect(result.status).toBe(202)
  await result.completion
  return result
}

describe('codex readyMarker cannot collide with its startup gate', () => {
  beforeEach(() => clearAgentsConfigCache())
  afterEach(() => clearAgentsConfigCache())

  it('does not match the "Hooks need review" gate screen', () => {
    for (const marker of resolveReadyMarkers('codex')) expect(CODEX_HOOKS_GATE_SCREEN).not.toContain(marker)
  })

  it('does match the real Codex prompt screen', () => {
    expect(resolveReadyMarkers('codex').some(marker => CODEX_READY_SCREEN.includes(marker))).toBe(true)
  })
})

describe('ready markers', () => {
  beforeEach(() => clearAgentsConfigCache())
  afterEach(() => clearAgentsConfigCache())

  it('offers more than one signal for claude, so one UI change cannot stall startup', () => {
    const markers = resolveReadyMarkers('claude code')
    expect(markers).toContain('❯')
    expect(markers.length).toBeGreaterThan(1)
  })

  it('never yields a blank marker, which would match every screen', () => {
    for (const program of ['codex', 'claude', 'aider', 'gemini', 'opencode']) {
      for (const marker of resolveReadyMarkers(program)) {
        expect(marker.trim()).not.toBe('')
      }
    }
  })

  it("claude's marker alone is not proof of readiness — the trust modal shows it too", () => {
    // Same trap as codex's "›": the glyph is also the modal's selection cursor.
    // Safe only because the gate check runs first; see the integration test.
    expect(matchReadyMarker(CLAUDE_TRUST_SCREEN, resolveReadyMarkers('claude'))).toBe('❯')
  })
})

describe('quiescent-screen fallback', () => {
  const QUIET_MS = 20_000

  it('treats a settled, unrecognised screen as ready', () => {
    expect(isQuiescentReady(CLAUDE_READY_SCREEN, QUIET_MS, QUIET_MS)).toBe(true)
  })

  it('keeps waiting while the screen is still changing', () => {
    expect(isQuiescentReady(CLAUDE_READY_SCREEN, QUIET_MS - 1, QUIET_MS)).toBe(false)
  })

  it('never fires on a bare PowerShell prompt — the CLI has not started', () => {
    // This screen is still forever. Reading it as "ready" would paste the whole
    // task prompt into PowerShell and run it as a command.
    expect(endsAtShellPrompt(POWERSHELL_PROMPT_SCREEN)).toBe(true)
    expect(isQuiescentReady(POWERSHELL_PROMPT_SCREEN, 10 * QUIET_MS, QUIET_MS)).toBe(false)
  })

  it('never fires on an empty screen', () => {
    expect(isQuiescentReady('   \n\n', 10 * QUIET_MS, QUIET_MS)).toBe(false)
  })

  it('does not mistake a real agent screen for a shell prompt', () => {
    expect(endsAtShellPrompt(CODEX_READY_SCREEN)).toBe(false)
    expect(endsAtShellPrompt(CLAUDE_READY_SCREEN)).toBe(false)
    expect(endsAtShellPrompt(CLAUDE_TRUST_SCREEN)).toBe(false)
  })
})

describe('startup gate auto-confirm', () => {
  let tempRoot: string
  let originalDataDir: string | undefined

  beforeEach(() => {
    vi.resetModules()
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-gates-'))
    originalDataDir = process.env.ENSEMBLE_DATA_DIR
    process.env.ENSEMBLE_DATA_DIR = tempRoot
  })

  afterEach(() => {
    vi.resetModules()
    if (originalDataDir === undefined) delete process.env.ENSEMBLE_DATA_DIR
    else process.env.ENSEMBLE_DATA_DIR = originalDataDir
    fs.rmSync(tempRoot, { recursive: true, force: true })
  })

  async function setup(
    program = 'codex',
    gateScreen = CODEX_HOOKS_GATE_SCREEN,
    readyScreen = CODEX_READY_SCREEN,
  ) {
    const team: EnsembleTeam = {
      id: 'team-gate',
      name: 'team-gate',
      description: 'gate test',
      status: 'forming',
      createdAt: new Date().toISOString(),
      createdBy: 'test',
      feedMode: 'live',
      workingDirectory: tempRoot,
      agents: [
        { agentId: '', name: `${program}-1`, program, role: 'lead', hostId: '', status: 'spawning' },
        { agentId: '', name: `${program}-2`, program, role: 'member', hostId: '', status: 'spawning' },
      ],
    } as EnsembleTeam

    // Screen script: the gate is on screen for the first 3 polls per session,
    // then the CLI reaches its prompt.
    const pollsPerSession = new Map<string, number>()
    const sendKeysCalls: Array<{ session: string; keys: string; opts?: unknown; pollAtSend: number }> = []
    const pasteCalls: Array<{ session: string; pollAtPaste: number }> = []

    const runtime = {
      screen: vi.fn((session: string) => {
        const n = (pollsPerSession.get(session) ?? 0) + 1
        pollsPerSession.set(session, n)
        return n <= 3 ? gateScreen : readyScreen
      }),
      sendKeys: vi.fn((session: string, keys: string, opts?: unknown) => {
        sendKeysCalls.push({ session, keys, opts, pollAtSend: pollsPerSession.get(session) ?? 0 })
      }),
      paste: vi.fn((session: string) => {
        pasteCalls.push({ session, pollAtPaste: pollsPerSession.get(session) ?? 0 })
      }),
      exists: vi.fn(() => true),
      onData: vi.fn(() => () => {}),
    }

    vi.doMock('../lib/ensemble-registry', () => ({
      createTeam: vi.fn(() => team),
      getTeam: vi.fn(() => team),
      updateTeam: vi.fn(() => team),
      loadTeams: vi.fn(() => []),
      appendMessage: vi.fn(),
      getMessages: vi.fn(() => []),
    }))
    vi.doMock('../lib/agent-spawner', () => ({
      spawnLocalAgent: vi.fn(async () => ({ id: 'agent-id' })),
      killLocalAgent: vi.fn(),
      getAgentTokenUsage: vi.fn(async () => 'unknown'),
    }))
    vi.doMock('../lib/agent-runtime', () => ({ getRuntime: vi.fn(() => runtime) }))
    vi.doMock('../lib/collab-paths', () => ({
      ensureCollabDirs: vi.fn(),
      scrubCollabRuntimePaths: vi.fn((s: string) => s),
      collabPromptFile: vi.fn((t: string, a: string) => path.join(tempRoot, `${t}-${a}.prompt.txt`)),
      collabSummaryFile: vi.fn((t: string) => path.join(tempRoot, `${t}.summary.txt`)),
      collabMessagesFile: vi.fn((t: string) => path.join(tempRoot, `${t}.messages.jsonl`)),
      collabRuntimeDir: vi.fn((t: string) => path.join(tempRoot, t)),
      collabFinishedMarker: vi.fn((t: string) => path.join(tempRoot, `${t}.finished`)),
    }))

    const mod = await import('../services/ensemble-service')
    return { mod, team, runtime, sendKeysCalls, pasteCalls }
  }

  it('answers the Codex hooks gate and only injects once the real prompt is up', async () => {
    const { mod, sendKeysCalls, pasteCalls } = await setup()

    await createAndWait(mod, {
      name: 'team-gate',
      description: 'gate test',
      agents: [{ program: 'codex' }, { program: 'codex' }],
      workingDirectory: tempRoot,
    })

    // The gate is answered with "3" (continue without trusting hooks).
    const gateAnswers = sendKeysCalls.filter(c => c.keys === '3')
    expect(gateAnswers.length).toBeGreaterThan(0)
    expect(gateAnswers[0].opts).toEqual({ literal: true })

    // Debounced: at most one answer per session per 3s window, not one per poll.
    for (const session of ['team-gate-codex-1', 'team-gate-codex-2']) {
      expect(gateAnswers.filter(c => c.session === session).length).toBeLessThanOrEqual(2)
    }

    // Injection happened, and only after the gate screen was replaced by the
    // real prompt (poll 4+). With readyMarker "›" this fired at poll 1.
    expect(pasteCalls.length).toBe(2)
    for (const call of pasteCalls) {
      expect(call.pollAtPaste).toBeGreaterThanOrEqual(4)
    }
  }, 60_000)

  it('answers the Claude folder-trust modal instead of trusting its "❯" cursor', async () => {
    // "❯" is claude's readyMarker AND the modal's selection cursor, so a
    // marker-first check would call this ready at poll 1 and paste the task
    // into a dialog. The gate check has to win.
    const { mod, sendKeysCalls, pasteCalls } = await setup(
      'claude', CLAUDE_TRUST_SCREEN, CLAUDE_READY_SCREEN,
    )

    await createAndWait(mod, {
      name: 'team-gate',
      description: 'gate test',
      agents: [{ program: 'claude' }, { program: 'claude' }],
      workingDirectory: tempRoot,
    })

    // The modal is dismissed with Enter ("1. Yes, I trust this folder").
    expect(sendKeysCalls.filter(c => c.keys === 'Enter').length).toBeGreaterThan(0)

    // Claude is a sendKeys agent, so the task arrives as a literal keystroke
    // burst — and only after the modal is off screen (poll 4+).
    const injections = sendKeysCalls.filter(c => c.keys.includes('COMMUNICATION RULES'))
    expect(injections.length).toBe(2)
    for (const call of injections) {
      expect(call.pollAtSend).toBeGreaterThanOrEqual(4)
    }
    expect(pasteCalls.length).toBe(0)
  }, 60_000)
})
