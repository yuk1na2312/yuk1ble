// A stand-in for an agent CLI: prints a ready marker, then echoes each submitted line as `got: <line>`.
// It lets tests and browser checks run the whole stack (PTY, readiness, delivery, streams) without
// starting a real, billable agent. Extra argv (a model flag, a per-run tag) is ignored.
import readline from 'node:readline'

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: Boolean(process.stdin.isTTY),
})
rl.setPrompt('FAKE AGENT READY > ')
process.stdout.write('fake agent started\n')
rl.prompt()
rl.on('line', line => {
  process.stdout.write(`got: ${line}\n`)
  rl.prompt()
})
rl.on('close', () => process.exit(0))
