/**
 * AgentProgram — everything specific to one agent CLI, as data.
 * Loaded and validated from agents.json at startup (see agent-config.ts);
 * no code names a CLI, so adding one is a JSON entry.
 */

/**
 * An interactive screen that blocks startup and needs an automated answer
 * (a folder-trust dialog, a hooks review). Gates are evaluated BEFORE the ready
 * markers: a marker can also be the dialog's selection cursor.
 */
export interface AgentGate {
  /** Shown in logs, and the debounce key. */
  name: string
  /** Regex source, matched case-insensitively against the screen. */
  pattern: string
  /** Sent in order when the gate is detected: named keys ("Enter", "Down") or literal text. */
  keys: string[]
  /** Sent instead of `keys` when the environment variable named by `trustEnv` is "1". */
  trustKeys?: string[]
  trustEnv?: string
  /** Send each key as literal text instead of a named key. */
  literal?: boolean
  /** Press Enter after each key. */
  enter?: boolean
}

/** Token-usage scraping: `pattern` has exactly one capture group, `format` puts it where `$1` is. */
export interface AgentUsagePattern {
  pattern: string
  format: string
}

export interface AgentModel {
  id: string
  label: string
}

export interface AgentProgram {
  /** The key in agents.json (e.g. "codex"). */
  name: string
  /** CLI command to launch the agent. */
  command: string
  /** Default flags appended to the command. */
  flags: string[]
  /** Flag that takes the working directory, added when the command line lacks it. */
  cwdFlag?: string
  /** Other spellings of `cwdFlag` that mean the command line already has it. */
  cwdFlagAliases?: string[]
  /** Flag that takes the ensemble repo root, so the agent can read the team-say CLI. */
  addDirFlag?: string
  /**
   * Strings on the agent's terminal that mean "ready for input", any one is enough.
   * Several independent signals keep one UI tweak from stalling startup, and a glyph
   * that is also a modal's selection cursor stays safe because gates run first.
   */
  readyMarkers: string[]
  /** How to deliver multi-line prompts. */
  inputMethod: 'pasteFromFile' | 'sendKeys'
  /** Regex source for the composer text of a paste that was not submitted. Absent means the default in src/core/paste-submit.ts. */
  pasteMarker?: string
  gates?: AgentGate[]
  usagePatterns?: AgentUsagePattern[]
  /** Flag that selects a model; required when `models` is non-empty. */
  modelFlag?: string
  /** The allowlist for per-agent model selection. No catalog means no picker. */
  models?: AgentModel[]
  /** Reserved for the skill picker; unused. */
  skillInvocation?: string
  /** Environment variables (regex sources, case-insensitive) withheld from the shells agents run in. */
  stripEnv?: string[]
  /** Hex colour for the GUI and CLI, e.g. "#6aa9ff". */
  color: string
  /** Single-char icon shown in the GUI. */
  icon: string
}

export interface AgentsConfig {
  [key: string]: AgentProgram
}
