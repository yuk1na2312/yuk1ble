/**
 * AgentProgram — Declarative configuration for AI agent programs.
 * Loaded from agents.json at runtime; eliminates hardcoded agent-specific logic.
 */

/**
 * How a program is asked to run one of its installed skills, for the "/"
 * picker in the monitoring GUI composer. See
 * docs/superpowers/specs/2026-08-16-agent-skill-invocation-design.md §3.
 *
 * - 'slash'  — deliver `/token args` raw, as a standalone command. Confirmed
 *              for claude.
 * - 'prose'  — deliver `Use your "<name>" skill: <args>` through the normal
 *              wrapped message path; no raw delivery.
 * - 'none'   — the program has no skills convention; the picker is disabled
 *              for it with a one-line reason.
 */
export type SkillInvocation = 'slash' | 'prose' | 'none'

export interface AgentProgram {
  /** Unique identifier matching the key in agents.json (e.g. "codex", "claude") */
  name: string
  /** CLI command to launch the agent (e.g. "codex", "claude", "aider") */
  command: string
  /** Default flags appended to the command (e.g. ["-m", "gpt-5.4"]) */
  flags: string[]
  /** String that appears in the agent terminal when it is ready for input */
  readyMarker: string
  /**
   * Extra strings that also mean "ready", any one of which is enough.
   *
   * A single marker is fragile: agent CLIs change their idle screen between
   * releases, and a glyph like "❯" is also used as a modal's selection cursor.
   * Listing several independent signals keeps a UI tweak from stalling startup
   * for the whole readiness window.
   */
  readyMarkers?: string[]
  /** How to deliver multi-line prompts */
  inputMethod: 'pasteFromFile' | 'sendKeys'
  /** Base color name for monitor TUI (e.g. "blue", "green", "magenta", "yellow") */
  color: string
  /** Single-char icon shown in monitor UI (e.g. "◆", "●", "▲", "★") */
  icon: string
  /** How this program is asked to run one of its installed skills. Defaults to 'none' when absent. */
  skillInvocation?: SkillInvocation
}

export interface AgentsConfig {
  [key: string]: AgentProgram
}
