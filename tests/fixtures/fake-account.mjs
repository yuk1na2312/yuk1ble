// A stand-in for an agent CLI's account status subcommand: prints fixed JSON, including a
// credential-shaped field, so tests and browser checks can run the accounts probe without
// asking a real, signed-in CLI. The token must never reach the API response.
process.stdout.write(JSON.stringify({
  loggedIn: true,
  email: 'ada@example.test',
  subscriptionType: 'Pro',
  accessToken: 'sk-fake-secret-token',
}) + '\n')
