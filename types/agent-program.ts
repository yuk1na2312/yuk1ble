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

/**
 * One curated, allowlisted model choice for a program's GUI dropdown. See
 * docs/superpowers/specs/2026-08-17-per-agent-model-selection-design.md §4.
 */
export interface AgentModel {
  /** Value passed verbatim to the CLI's model flag. */
  id: string
  /** Human label for the GUI dropdown. */
  label: string
}

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
  /**
   * The flag name this program's model selection is passed under (e.g.
   * "--model"). Per-program because it is not universal — a future program
   * may spell it differently. Absent alongside `models` means this program
   * gets no model picker.
   */
  modelFlag?: string
  /**
   * Curated allowlist of models this program's GUI dropdown may offer.
   * Absent means this program gets no model picker — the same degradation
   * path `skillInvocation: "none"` already takes.
   */
  models?: AgentModel[]
}

export interface AgentsConfig {
  [key: string]: AgentProgram
}
