# Contributing

Thanks for contributing to Agent Sessions.

## Development setup

1. Install Node.js 20 or newer and VS Code 1.90 or newer.
2. Run `npm ci`.
3. Run `npm test` before submitting a change.
4. Press `F5` in VS Code for interactive extension testing.

Keep provider-specific behavior inside `src/process/` or behind a provider branch in the shared core. UI state and persisted records should remain provider-neutral whenever possible.

Do not commit credentials, provider session data, generated VSIX files, build output or local agent configuration. New behavior should include deterministic tests that do not call paid services.

## Pull requests

- Keep changes focused and explain user-visible behavior.
- Add or update tests for behavior changes.
- Update the README when commands, settings, requirements or privacy behavior change.
- Confirm `npm test` and `npm run package` succeed.
