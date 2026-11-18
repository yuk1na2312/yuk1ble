import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EnsembleMessage, EnsembleTeam } from '../src/types'

function makeMessage(overrides: Partial<EnsembleMessage> = {}): EnsembleMessage {
  return {
    id: overrides.id ?? `msg-${Math.random().toString(36).slice(2, 8)}`,
    teamId: overrides.teamId ?? 'team-staged',
    from: overrides.from ?? 'codex-1',
    to: overrides.to ?? 'team',
    content: overrides.content ?? 'hello',
    type: overrides.type ?? 'chat',
    timestamp: overrides.timestamp ?? '2026-03-19T10:00:00.000Z',
  }
}

function makeTeam(): EnsembleTeam {
  return {
    id: 'team-staged',
    name: 'team-staged',
    description: 'Implement staged workflow',
    status: 'active',
    agents: [
      { agentId: 'a1', name: 'codex-1', program: 'codex', role: 'lead', hostId: 'local', status: 'active' },
      { agentId: 'a2', name: 'claude-2', program: 'claude', role: 'member', hostId: 'local', status: 'active' },
    ],
    createdBy: 'test',
    createdAt: '2026-03-19T09:00:00.000Z',
    feedMode: 'live',
  }
}

/** Every prompt is followed by the 1.5 s submit check, so run the workflow on a clock that skips those waits. */
async function runOnFakeClock(run: () => Promise<void>): Promise<void> {
  vi.useFakeTimers({ toFake: ['setTimeout'] })
  try {
    const done = run()
    await vi.advanceTimersByTimeAsync(60_000)
    await done
  } finally {
    vi.useRealTimers()
  }
}

describe('StagedWorkflowManager', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.restoreAllMocks()
  })

  afterEach(() => {
    vi.resetModules()
    vi.restoreAllMocks()
  })

  it('runs PLAN → EXEC → VERIFY in order', async () => {
    const delivered: Array<{ session: string; text: string }> = []
    const appended: string[] = []
    let messageReadCount = 0

    vi.doMock('../src/core/store', () => ({
      appendMessage: vi.fn((_teamId: string, message: EnsembleMessage) => appended.push(message.content)),
      getMessages: vi.fn((_teamId: string, _since?: string) => {
        messageReadCount += 1
        if (messageReadCount === 1) {
          return [
            makeMessage({ from: 'codex-1', content: 'plan ready', timestamp: '2026-03-19T10:00:01.000Z' }),
            makeMessage({ from: 'claude-2', content: 'plan klaar', timestamp: '2026-03-19T10:00:02.000Z' }),
          ]
        }
        return [
          makeMessage({ from: 'codex-1', content: 'implementation done', timestamp: '2026-03-19T10:00:03.000Z' }),
          makeMessage({ from: 'claude-2', content: 'implementatie klaar', timestamp: '2026-03-19T10:00:04.000Z' }),
        ]
      }),
    }))
    vi.doMock('../src/runtime/agent-runtime', () => ({
      getRuntime: vi.fn(() => ({
        sendKeys: vi.fn((session: string, text: string) => {
          delivered.push({ session, text })
        }),
        paste: vi.fn(() => {}),
        exists: vi.fn(() => true),
        screen: vi.fn(() => '> '),
      })),
    }))
    vi.doMock('../src/adapters/agent-config', () => ({
      resolveAgentProgram: vi.fn(() => ({ inputMethod: 'sendKeys' })),
      resolveReadyMarkers: vi.fn(() => ['>']),
    }))
    vi.doMock('../src/core/agent-spawner', () => ({
    }))

    const { StagedWorkflowManager } = await import('../src/core/staged-workflow')

    const manager = new StagedWorkflowManager({
      team: makeTeam(),
      config: {
        planTimeoutMs: 100,
        execTimeoutMs: 100,
        verifyTimeoutMs: 0,
        pollIntervalMs: 0,
      },
      sleep: async () => {},
      buildPlanPrompt: ({ agent }) => `PLAN for ${agent.name}`,
      buildExecPrompt: ({ agent }) => `EXEC for ${agent.name}`,
      buildVerifyPrompt: ({ agent, teammateToReview }) => `VERIFY ${agent.name} reviews ${teammateToReview}`,
    })

    await runOnFakeClock(() => manager.run())

    expect(delivered.map(entry => entry.text)).toEqual([
      'PLAN for codex-1',
      'PLAN for claude-2',
      'EXEC for codex-1',
      'EXEC for claude-2',
      'VERIFY codex-1 reviews claude-2',
      'VERIFY claude-2 reviews codex-1',
    ])
    expect(appended.some(message => message.includes('[Staged/PLAN] Starting PLAN phase'))).toBe(true)
    expect(appended.some(message => message.includes('[Staged/EXEC] Starting EXEC phase'))).toBe(true)
    expect(appended.some(message => message.includes('[Staged/VERIFY] Starting VERIFY phase'))).toBe(true)
  })

  it('submits every staged prompt: a prompt left parked in the composer is a silent agent', async () => {
    const pastes: string[] = []
    const enters: string[] = []
    const typed: string[] = []
    // The composer holds a parked paste until an Enter has been sent for it.
    const runtime = {
      paste: vi.fn((session: string) => { pastes.push(session) }),
      sendKeys: vi.fn((session: string, keys: string, opts?: { literal?: boolean }) => {
        if (keys === 'Enter' && !opts?.literal) enters.push(session)
        else typed.push(session)
      }),
      exists: vi.fn(() => true),
      screen: vi.fn((session: string) =>
        pastes.filter(s => s === session).length > enters.filter(s => s === session).length
          ? '› [Pasted Content 1929 chars]'
          : '› '),
    }
    vi.doMock('../src/runtime/agent-runtime', () => ({ getRuntime: vi.fn(() => runtime) }))
    vi.doMock('../src/adapters/agent-config', () => ({
      resolveAgentProgram: vi.fn(() => ({ inputMethod: 'pasteFromFile' })),
    }))
    const { StagedWorkflowManager } = await import('../src/core/staged-workflow')
    const manager = new StagedWorkflowManager({
      team: makeTeam(),
      config: { planTimeoutMs: 1, execTimeoutMs: 1, verifyTimeoutMs: 0, pollIntervalMs: 0 },
      sleep: async () => {},
      buildPlanPrompt: () => 'plan',
      buildExecPrompt: () => 'exec',
      buildVerifyPrompt: () => 'verify',
    })

    await runOnFakeClock(() => manager.run())

    // Three phases, two agents: six pastes, and one Enter for each.
    expect(pastes).toHaveLength(6)
    expect(enters).toHaveLength(6)
    expect(typed).toEqual([])
  })

  it('has every agent of a larger team review exactly one teammate, in a ring', async () => {
    const { StagedWorkflowManager } = await import('../src/core/staged-workflow')
    const team = makeTeam()
    team.agents.push({ agentId: 'a3', name: 'codex-3', program: 'codex', role: 'worker', status: 'active' })
    const reviews: string[] = []

    const ring = new StagedWorkflowManager({
      team,
      config: { planTimeoutMs: 1, execTimeoutMs: 1, verifyTimeoutMs: 0, pollIntervalMs: 0 },
      sleep: async () => {},
      buildPlanPrompt: () => 'plan',
      buildExecPrompt: () => 'exec',
      buildVerifyPrompt: ({ agent, teammateToReview }) => { reviews.push(`${agent.name}>${teammateToReview}`); return 'verify' },
    })
    await runOnFakeClock(() => ring.run())

    expect(reviews).toEqual(['codex-1>claude-2', 'claude-2>codex-3', 'codex-3>codex-1'])
  })
})
