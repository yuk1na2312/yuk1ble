import { v4 as uuidv4 } from 'uuid'
import type {
  EnsembleTeam,
  EnsembleTeamAgent,
  StagedWorkflowConfig,
} from '../types/ensemble'
import { appendMessage, getMessages } from './ensemble-registry'
import { getRuntime } from './agent-runtime'
import { resolveAgentProgram } from './agent-config'
import { collabDeliveryFile } from './collab-paths'
import { isSelf, getHostById } from './hosts-config'
import { postRemoteSessionCommand } from './agent-spawner'
import fs from 'fs'
import path from 'path'

const DEFAULT_PLAN_TIMEOUT_MS = 120_000
const DEFAULT_EXEC_TIMEOUT_MS = 300_000
const DEFAULT_VERIFY_TIMEOUT_MS = 120_000
const DEFAULT_POLL_INTERVAL_MS = 5_000

const PLAN_SHARED_PATTERNS = [
  /\bplan\b/i,
  /\bstrateg/i,
  /\bapproach\b/i,
  /\bstappen\b/i,
  /\baanpak\b/i,
  /\bvoorstel\b/i,
  /\bready\b/i,
  /\bklaar\b/i,
]

const EXEC_DONE_PATTERNS = [
  /\bdone\b/i,
  /\bcomplete(?:d)?\b/i,
  /\bafgerond\b/i,
  /\bklaar\b/i,
  /\bfinished\b/i,
  /\bimplemented\b/i,
  /\bgeïmplementeerd\b/i,
]

type ActiveAgent = Pick<EnsembleTeamAgent, 'name' | 'program' | 'hostId' | 'status'>

interface PromptContext {
  agent: ActiveAgent
  teammates: string[]
  index: number
}

interface StagedWorkflowManagerOptions {
  team: EnsembleTeam
  config?: StagedWorkflowConfig
  buildPlanPrompt?: (context: PromptContext) => string
  buildExecPrompt?: (context: PromptContext) => string
  buildVerifyPrompt?: (context: PromptContext & { teammateToReview?: string }) => string
  sleep?: (ms: number) => Promise<void>
  now?: () => Date
}

function resolveConfig(config?: StagedWorkflowConfig): Required<StagedWorkflowConfig> {
  return {
    planTimeoutMs: config?.planTimeoutMs ?? DEFAULT_PLAN_TIMEOUT_MS,
    execTimeoutMs: config?.execTimeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS,
    verifyTimeoutMs: config?.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS,
    pollIntervalMs: config?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
  }
}

function defaultPlanPrompt({ teammates }: PromptContext): string {
  return [
    `⏳ PHASE 1 — PLAN ONLY.`,
    `Do NOT write code or edit files yet.`,
    `Create a concrete implementation plan and share it with ${teammates.join(', ')} via team-say.`,
    `Say "plan ready" when you have shared your plan.`,
  ].join(' ')
}

function defaultExecPrompt({ teammates }: PromptContext): string {
  return [
    `🚀 PHASE 2 — EXECUTE.`,
    `You may now implement the agreed plan.`,
    `Keep ${teammates.join(', ')} updated via team-say.`,
    `Say "implementation done" when your execution work is complete.`,
  ].join(' ')
}

function defaultVerifyPrompt({ teammateToReview }: PromptContext & { teammateToReview?: string }): string {
  return [
    `🔍 PHASE 3 — VERIFY.`,
    `Review ${teammateToReview || 'your teammate'}'s work.`,
    `Share findings via team-say and say "review complete" when done.`,
  ].join(' ')
}

export class StagedWorkflowManager {
  private readonly config: Required<StagedWorkflowConfig>
  private readonly sleep: (ms: number) => Promise<void>
  private readonly now: () => Date
  private readonly agents: ActiveAgent[]
  private messageCursor: string | undefined

  constructor(private readonly options: StagedWorkflowManagerOptions) {
    this.config = resolveConfig(options.config)
    this.sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)))
    this.now = options.now || (() => new Date())
    this.agents = options.team.agents.filter(agent => agent.status === 'active')
  }

  async run(): Promise<void> {
    if (this.agents.length < 2) {
      this.log('plan', 'Staged workflow requires at least 2 active agents')
      return
    }

    this.log('plan', 'Starting PLAN phase — agents may only plan and coordinate')
    const planStartedAt = new Date().toISOString()
    await Promise.all(this.agents.map((agent, index) => this.deliverPlanPrompt(agent, index)))

    const planResult = await this.waitForConditionOrTimeout(
      () => this.agentsSharedPlans(planStartedAt),
      this.config.planTimeoutMs,
    )
    this.log(
      'plan',
      planResult === 'condition'
        ? 'All agents shared their plans — advancing to EXEC'
        : `PLAN phase timed out after ${Math.round(this.config.planTimeoutMs / 1000)}s — advancing to EXEC`,
    )

    // Reset cursor and cache for next phase
    this.resetCursor()

    this.log('exec', 'Starting EXEC phase — agents may now implement')
    const execStartedAt = new Date().toISOString()
    await Promise.all(this.agents.map((agent, index) => this.deliverExecPrompt(agent, index)))

    const execResult = await this.waitForConditionOrTimeout(
      () => this.agentsCompletedExec(execStartedAt),
      this.config.execTimeoutMs,
    )
    this.log(
      'exec',
      execResult === 'condition'
        ? 'All agents completed implementation — advancing to VERIFY'
        : `EXEC phase timed out after ${Math.round(this.config.execTimeoutMs / 1000)}s — advancing to VERIFY`,
    )

    // Reset cursor and cache for next phase
    this.resetCursor()

    this.log('verify', 'Starting VERIFY phase — agents review each other\'s work')
    await Promise.all(this.agents.map((agent, index) => this.deliverVerifyPrompt(agent, index)))

    if (this.config.verifyTimeoutMs > 0) {
      await this.sleep(this.config.verifyTimeoutMs)
      this.log('verify', `VERIFY phase window elapsed after ${Math.round(this.config.verifyTimeoutMs / 1000)}s`)
    }
  }

  private async deliverPlanPrompt(agent: ActiveAgent, index: number): Promise<void> {
    const teammates = this.agentNames().filter(name => name !== agent.name)
    const prompt = (this.options.buildPlanPrompt || defaultPlanPrompt)({ agent, teammates, index })
    await this.deliverToAgent(agent, prompt)
  }

  private async deliverExecPrompt(agent: ActiveAgent, index: number): Promise<void> {
    const teammates = this.agentNames().filter(name => name !== agent.name)
    const prompt = (this.options.buildExecPrompt || defaultExecPrompt)({ agent, teammates, index })
    await this.deliverToAgent(agent, prompt)
  }

  private async deliverVerifyPrompt(agent: ActiveAgent, index: number): Promise<void> {
    const teammates = this.agentNames().filter(name => name !== agent.name)
    const prompt = (this.options.buildVerifyPrompt || defaultVerifyPrompt)({
      agent,
      teammates,
      teammateToReview: teammates[0],
      index,
    })
    await this.deliverToAgent(agent, prompt)
  }

  private async deliverToAgent(agent: ActiveAgent, text: string): Promise<void> {
    const sessionName = `${this.options.team.name}-${agent.name}`
    const runtime = getRuntime()

    if (agent.hostId && !isSelf(agent.hostId)) {
      const host = getHostById(agent.hostId)
      if (host) {
        await postRemoteSessionCommand(host.url, sessionName, text)
      }
      return
    }

    const agentCfg = resolveAgentProgram(agent.program)
    if (agentCfg.inputMethod === 'pasteFromFile') {
      const tmpFile = collabDeliveryFile(this.options.team.id, sessionName)
      fs.mkdirSync(path.dirname(tmpFile), { recursive: true })
      fs.writeFileSync(tmpFile, text)
      await runtime.pasteFromFile(sessionName, tmpFile)
      return
    }

    await runtime.sendKeys(sessionName, text, { literal: true, enter: true })
  }

  private resetCursor(): void {
    this.messageCursor = undefined
    this.messageCache = []
  }

  /**
   * Fetch messages incrementally using a cursor (consistent with monitor.ts).
   * On first call for a phase, uses sinceTimestamp. Subsequent polls advance
   * the cursor to the latest message timestamp to avoid re-reading old data.
   */
  private fetchMessagesSince(sinceTimestamp: string): ReturnType<typeof getMessages> {
    const since = this.messageCursor ?? sinceTimestamp
    const messages = getMessages(this.options.team.id, since)
    if (messages.length > 0) {
      this.messageCursor = messages[messages.length - 1].timestamp
    }
    return messages
  }

  private messageCache: ReturnType<typeof getMessages> = []

  private agentsSharedPlans(sinceTimestamp: string): boolean {
    const newMessages = this.fetchMessagesSince(sinceTimestamp)
    this.messageCache.push(...newMessages)
    return this.agentNames().every(name =>
      this.messageCache.some(message =>
        message.from === name && PLAN_SHARED_PATTERNS.some(pattern => pattern.test(message.content))
      ),
    )
  }

  private agentsCompletedExec(sinceTimestamp: string): boolean {
    const newMessages = this.fetchMessagesSince(sinceTimestamp)
    this.messageCache.push(...newMessages)
    return this.agentNames().every(name =>
      this.messageCache.some(message =>
        message.from === name && EXEC_DONE_PATTERNS.some(pattern => pattern.test(message.content))
      ),
    )
  }

  private async waitForConditionOrTimeout(
    check: () => boolean,
    timeoutMs: number,
  ): Promise<'condition' | 'timeout'> {
    const deadline = this.now().getTime() + timeoutMs
    while (this.now().getTime() < deadline) {
      if (check()) return 'condition'
      await this.sleep(this.config.pollIntervalMs)
    }
    return 'timeout'
  }

  private log(phase: 'plan' | 'exec' | 'verify', content: string): void {
    appendMessage(this.options.team.id, {
      id: uuidv4(),
      teamId: this.options.team.id,
      from: 'ensemble',
      to: 'team',
      content: `[Staged/${phase.toUpperCase()}] ${content}`,
      type: 'chat',
      timestamp: new Date().toISOString(),
    })
  }

  private agentNames(): string[] {
    return this.agents.map(agent => agent.name)
  }
}

export async function runStagedWorkflow(
  team: EnsembleTeam,
  config?: StagedWorkflowConfig,
  promptBuilders?: Pick<StagedWorkflowManagerOptions, 'buildPlanPrompt' | 'buildExecPrompt' | 'buildVerifyPrompt'>,
): Promise<void> {
  const manager = new StagedWorkflowManager({
    team,
    config,
    ...promptBuilders,
  })
  await manager.run()
}
