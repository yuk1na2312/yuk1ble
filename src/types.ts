/** What a service call answers with; the HTTP layer turns `error` into the response body and `status` into its code. */
export interface ServiceResult<T> {
  data?: T
  error?: string
  status: number
}

export interface EnsembleTeam {
  id: string
  name: string
  description: string
  status: 'forming' | 'active' | 'paused' | 'completed' | 'disbanded' | 'failed'
  agents: EnsembleTeamAgent[]
  createdBy: string
  createdAt: string
  completedAt?: string
  feedMode: 'silent' | 'summary' | 'live'
  result?: EnsembleTeamResult
  /**
   * ISO timestamp of when this run was archived; absent means not archived.
   * Records written before this field existed are simply not archived.
   */
  archivedAt?: string
  /**
   * The directory this team's agents were spawned into, as requested at creation. Absent means the
   * server's own cwd was used: `resolveAgentProjectDir` in src/core/skill-invoke.ts is the one place
   * that fallback is applied. Persisted so project-scoped skill discovery can read it back later;
   * records written before the field existed simply have no value, which resolves the same way.
   */
  workingDirectory?: string
}

export interface EnsembleTeamAgent {
  agentId: string
  name: string
  /** The runtime session of this agent's terminal (src/core/session-name.ts); what the session routes are addressed by. */
  sessionName?: string
  program: string
  role: string
  /** Model requested at creation. Absent means no model flag was passed: the CLI used its own default. */
  model?: string
  /** Legacy field from remote-host support. Kept optional so old teams.json records still load; nothing reads it. */
  hostId?: string
  status: 'spawning' | 'active' | 'idle' | 'done' | 'failed'
  /**
   * Set by the watchdog when an agent stops making progress after a nudge.
   * Deliberately NOT folded into `status`: message delivery only targets
   * `status === 'active'` agents, and a stalled agent must keep receiving
   * teammate messages so it can recover.
   */
  stalledAt?: string
  worktreePath?: string
  worktreeBranch?: string
}

export interface EnsembleTeamResult {
  summary: string
  decisions: string[]
  discoveries: string[]
  filesChanged: string[]
  duration: number
}

export interface EnsembleMessage {
  id: string
  teamId: string
  from: string
  to: string
  content: string
  type: 'chat' | 'decision' | 'question' | 'result' | 'command'
  timestamp: string
  options?: string[]
  /** Per-team monotonically increasing sequence number, assigned by the store on append. */
  seq?: number
}

export interface CreateTeamRequest {
  name: string
  description: string
  agents: Array<{
    program: string
    role?: string
    /** Must be in the program's catalog (agents.json). Absent means the CLI default. */
    model?: string
    /** Accepted and ignored: all agents run locally. */
    hostId?: string
  }>
  feedMode?: 'silent' | 'summary' | 'live'
  workingDirectory?: string
  templateName?: string
  useWorktrees?: boolean
  staged?: boolean
  stagedConfig?: StagedWorkflowConfig
}

export type StagedPhase = 'plan' | 'exec' | 'verify'

export interface StagedWorkflowConfig {
  planTimeoutMs?: number   // Max time for PLAN phase before auto-advancing (default: 120000 = 2min)
  execTimeoutMs?: number   // Max time for EXEC phase before auto-advancing (default: 300000 = 5min)
  verifyTimeoutMs?: number // Max time for VERIFY phase before completing (default: 120000 = 2min)
  pollIntervalMs?: number  // How often to check for phase completion (default: 5000 = 5s)
}

export interface CollabTemplateRole {
  role: string
  focus: string
}

export interface CollabTemplate {
  name: string
  description: string
  suggestedTaskPrefix: string
  roles: CollabTemplateRole[]
}

export interface CollabTemplatesFile {
  templates: Record<string, CollabTemplate>
}
