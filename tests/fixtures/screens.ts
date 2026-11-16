/**
 * Terminal screens captured live through PtyRuntime.capturePane, shared by the
 * tests that pin readiness behaviour.
 */

// Codex v0.147 "Hooks need review" startup gate. Its "›" is the selection cursor,
// which is why codex's ready marker can never be "›".
export const CODEX_HOOKS_GATE_SCREEN = [
  '  Hooks need review',
  '  4 hooks are new or changed.',
  '  Hooks can run outside the sandbox after you trust them.',
  '› 1. Review hooks',
  '  2. Trust all and continue',
  "  3. Continue without trusting (hooks won't run)",
  '  Press enter to confirm or esc to go back',
].join('\n')

export const CODEX_READY_SCREEN = [
  '╭──────────────────────────────────────────────────╮',
  '│ >_ OpenAI Codex (v0.147.0)                       │',
  '│                                                  │',
  '│ model:       gpt-5.6-sol high   /model to change │',
  '│ directory:   E:\\projects\\ensemble-win\\ensemble   │',
  '│ permissions: YOLO mode                           │',
  '╰──────────────────────────────────────────────────╯',
  '',
  '› Find and fix a bug in @filename',
].join('\n')

// Verbatim capturePane output from a real `claude --permission-mode auto`
// launched by PtyRuntime in a directory it had not seen before.
export const CLAUDE_TRUST_SCREEN = [
  ' Accessing workspace:',
  ' C:\\Users\\khoin\\AppData\\Local\\Temp\\ensemble-trust-probe-1786635817286',
  ' Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source',
  " project, or work from your team). If not, take a moment to review what's in this folder first.",
  " Claude Code'll be able to read, edit, and execute files here.",
  ' Security guide',
  ' ❯ 1. Yes, I trust this folder',
  '   2. No, exit',
].join('\n')

export const CLAUDE_READY_SCREEN = [
  '─────────────────────────────────────────────────',
  '❯ ',
].join('\n')

export const POWERSHELL_PROMPT_SCREEN = [
  'Windows PowerShell',
  'Copyright (C) Microsoft Corporation. All rights reserved.',
  '',
  'PS E:\\projects\\ensemble-win\\ensemble>',
].join('\n')
