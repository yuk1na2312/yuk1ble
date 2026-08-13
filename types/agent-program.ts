/**
 * AgentProgram — Declarative configuration for AI agent programs.
 * Loaded from agents.json at runtime; eliminates hardcoded agent-specific logic.
 */

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
}

export interface AgentsConfig {
  [key: string]: AgentProgram
}
