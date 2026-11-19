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

/** Reading the status subcommand's JSON: the first key of each list that holds a value of the right type wins. */
export interface AgentAccountJson {
  /** Keys of a boolean: true is signed in, false signed out. */
  signedIn: string[]
  /** Keys of a string. */
  account: string[]
  plan: string[]
}

/** Reading its plain text; every pattern is a case-insensitive regex source. */
export interface AgentAccountText {
  /** Checked first: a "not logged in" line also contains "logged in". */
  signedOut: string
  signedIn: string
  /** Each has exactly one capture group; the first that matches wins. */
  account: string[]
  plan: string[]
}

/**
 * How to ask the CLI who is signed in (read-only, GET /api/ensemble/accounts), or why it cannot say.
 * `args` follow the program's `command`; only the fields named here ever leave the probe.
 */
export type AgentAccount =
  | { unsupported: string }
  | { args: string[]; json: AgentAccountJson }
  | { args: string[]; text: AgentAccountText }

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
  /** Account-status probe, or the reason there is none. Absent: reported as unsupported. */
  account?: AgentAccount
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
