import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** The prompt each agent receives, for teams of two and of N. */
describe('buildPromptPreview', () => {
  beforeEach(() => { vi.resetModules(); vi.spyOn(console, 'log').mockImplementation(() => {}) })
  afterEach(() => { vi.restoreAllMocks(); vi.resetModules() })

  async function prompt(agentIndex: number, names: string[], templateName?: string) {
    const { buildPromptPreview } = await import('../src/core/team-lifecycle')
    return buildPromptPreview({
      teamId: 'tid', teamName: 'squad', description: 'the task',
      agentName: names[agentIndex], teammateNames: names.filter((_, i) => i !== agentIndex), agentIndex, templateName,
    })
  }

  it('targets "team" and lists every teammate', async () => {
    const text = await prompt(1, ['codex-1', 'claude-2', 'plain-3'])
    expect(text).toContain('You are claude-2 in team "squad" with teammates codex-1, plain-3.')
    expect(text).toMatch(/team-say tid claude-2 team "your message"/)
    expect(text).not.toMatch(/team-say tid claude-2 codex-1/)
  })

  it('keeps the singular for two agents', async () => {
    expect(await prompt(0, ['codex-1', 'claude-2'])).toContain('with teammate claude-2.')
  })

  it('words the done protocol for N agents, not "both"', async () => {
    const text = await prompt(0, ['codex-1', 'claude-2', 'plain-3'])
    expect(text).toContain('every agent still active in the team has sent <<COLLAB_DONE>>')
    expect(text).not.toMatch(/\bboth\b/i)
    expect(text).not.toContain('your teammate ')
  })

  it('gives the first agent the lead role and every other one the worker role', async () => {
    const names = ['codex-1', 'claude-2', 'plain-3']
    expect(await prompt(0, names)).toContain('ROLE: LEAD.')
    expect(await prompt(1, names)).toContain('ROLE: WORKER.')
    expect(await prompt(2, names)).toContain('ROLE: WORKER.')
  })

  it('applies a template by index and falls back to worker beyond its roles', async () => {
    const names = ['codex-1', 'claude-2', 'plain-3']
    expect(await prompt(0, names, 'review')).toContain('ROLE: REVIEWER.')
    expect(await prompt(1, names, 'review')).toContain('ROLE: CRITIC.')
    expect(await prompt(2, names, 'review')).toContain('ROLE: WORKER.')
  })
})
