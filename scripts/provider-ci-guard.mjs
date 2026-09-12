// Ordinary gates cannot opt into a paid operation, even when credentials exist.
if (process.env.AGNES_REAL_CREATE_ENABLED?.trim().toLowerCase() === 'true') {
  process.stderr.write(process.env.CI && process.env.CI !== 'false'
    ? 'REAL_PROVIDER_CALL_FORBIDDEN_IN_CI\n'
    : 'REAL_PROVIDER_CREATE_DISABLED\n');
  process.exitCode = 1;
}
