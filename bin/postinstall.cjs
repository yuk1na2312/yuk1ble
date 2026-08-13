#!/usr/bin/env node

/**
 * postinstall - verify native Windows runtime dependencies.
 */

try {
  require('node-pty');
} catch (error) {
  console.error(`
[ensemble] ERROR: node-pty could not be loaded.

Native Windows requires node-pty and its native ConPTY binding. Install:
  - Node.js 18+ LTS
  - Visual Studio Build Tools with "Desktop development with C++"
  - PowerShell 7 and Windows Terminal (recommended)

Then run "npm install" again.
See "Windows prerequisites" in README.md.
`);
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
