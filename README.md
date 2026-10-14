# Agent Sessions

Agent Sessions is a vendor-neutral VS Code workspace for running and monitoring multiple coding-agent sessions. It currently supports **Claude Code** and **OpenAI Codex**, with an architecture designed to add more providers later.

Each session stays visible in a shared sidebar and board with its current state, subagents, model, context usage, token usage and cost. Opening a session gives you a detachable chat tab with streaming output, approvals, questions, attachments and queued messages.

> Agent Sessions is an independent open-source project. It is not affiliated with, endorsed by, or sponsored by Anthropic or OpenAI.

## Features

- Run Claude Code and Codex sessions from the same UI.
- Monitor **Running**, **Waiting for you** and **Done** sessions.
- Organize sessions by status or Git repository.
- Keep sessions running when their chat tab is closed.
- Review streamed replies, reasoning summaries, tool calls and tool output.
- Approve or deny tool requests and answer agent questions.
- Inspect nested foreground and background subagents.
- Queue messages while an agent is working.
- Attach or paste images.
- Dictate prompts using the microphone.
- Resume, fork, archive and reopen conversations.
- Copy the provider-native session ID for use outside the extension.
- Track context, tokens, account limits and estimated cost.
- Open a managed conversation in its native terminal UI.

## Requirements

- VS Code 1.90 or newer.
- At least one supported agent CLI:
  - [Claude Code](https://docs.anthropic.com/en/docs/claude-code), signed in and available as `claude`.
  - [OpenAI Codex](https://developers.openai.com/codex/), signed in and available as `codex`, or installed through the official Codex VS Code extension.

Agent Sessions resolves CLI executables from the login shell. You can override their paths in Settings.

Voice dictation requires the Codex Audio helper installed with the official Codex extension. Dictation uses your existing Codex sign-in even when the active chat is a Claude session.

## Installation

### From a packaged VSIX

```bash
npm ci
npm run package
code --install-extension agent-sessions-0.11.7.vsix
```

After installation, run **Developer: Reload Window**.

### From source

```bash
git clone https://github.com/eknid-mucollari/agent-sessions.git
cd agent-sessions
npm ci
npm test
```

Open the repository in VS Code and press `F5` to start an Extension Development Host.

## Getting started

1. Open the **Agent Sessions** activity-bar view.
2. Select **New Session**.
3. Choose a provider, working folder, model and session name.
4. Send the first message from the session tab.

You can also right-click any folder in the VS Code Explorer and select **New Agent Session Here**.

Right-click a session for lifecycle actions such as **Copy Session ID**, **Fork Conversation**, **Archive**, **Resume Session** or **Open in Native Terminal**. For a new Codex session, send at least one message before copying its native thread ID.

## Chat behavior

- `Enter` sends a message; `Shift+Enter` inserts a new line.
- `Escape` interrupts the active turn.
- Messages submitted while an agent is busy enter a FIFO queue.
- Closing a chat tab does not stop its process.
- Pasting or selecting images attaches them to the next message.
- Typing `/` opens the commands and skills available for the active provider.
- `/native` opens the same conversation in the provider's terminal interface.

The extension handles common local commands such as `/help`, `/status`, `/cost`, `/resume`, `/permissions` and `/exit`. Provider-native operations and skills are forwarded through their supported APIs. Commands that require an interactive TUI remain available through `/native`.

## Configuration

All settings use the `agentSessions.*` namespace.

| Setting | Purpose |
| --- | --- |
| `agentSessions.defaultProvider` | Preferred provider in the new-session picker. |
| `agentSessions.groupBy` | Group sidebar sessions by `status` or `repository`. |
| `agentSessions.notifications` | Notify when a background session finishes or needs input. |
| `agentSessions.claudePath` | Explicit path to the Claude Code executable. |
| `agentSessions.defaultModel` | Default model for Claude sessions. |
| `agentSessions.additionalClaudeModels` | Extra Claude model IDs or deployment names. |
| `agentSessions.permissionMode` | Default Claude permission mode. |
| `agentSessions.extraArgs` | Extra arguments passed to Claude Code. |
| `agentSessions.codexPath` | Explicit path to the Codex executable. |
| `agentSessions.codexDefaultModel` | Default model for Codex sessions. |
| `agentSessions.additionalCodexModels` | Extra Codex model IDs. |
| `agentSessions.codexApprovalPolicy` | Default Codex approval policy. |
| `agentSessions.codexSandbox` | Default Codex sandbox mode. |
| `agentSessions.codexExtraArgs` | Extra arguments passed to `codex app-server`. |
| `agentSessions.pricingOverrides` | Optional model pricing overrides for estimates. |

## Data and privacy

- Session metadata and event logs are stored in VS Code's extension global-storage directory.
- API credentials are obtained from the installed provider CLIs and are not written to session logs.
- Agent prompts and attachments are sent only to the provider selected for that session.
- Voice audio is sent to OpenAI's transcription service and is not added to the session event log.
- The extension does not include analytics or telemetry of its own.

Cost values are estimates unless a provider supplies an authoritative total. Subscription usage, regional pricing, priority processing and tool fees may differ from displayed estimates.

## Supported providers

### Claude Code

Claude sessions use the CLI's stream-JSON protocol. The extension supports model selection, permission modes, account-credit display, subagents, resume and fork.

### OpenAI Codex

Codex sessions use `codex app-server`. The extension supports model discovery, reasoning effort, approval and sandbox controls, account-usage windows, skills, persistent goals, compaction, review, resume and fork.

Adding another provider requires an adapter that maps its native lifecycle and events into the shared session model; the UI and persistence layers are provider-independent.

## Development

```bash
npm ci
npm run compile
npm test
npm run package
```

The default test suite uses deterministic fake agent processes and does not consume provider credits. The optional end-to-end Claude test is enabled explicitly:

```bash
npm run test:e2e
```

Main modules:

```text
src/core/             shared session state, persistence, pricing and commands
src/process/          provider process and RPC adapters
src/ui/               sidebar, board, metrics and chat panels
resources/            webview scripts, styles and extension icons
test/                 unit, integration and VS Code smoke tests
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines and [SECURITY.md](SECURITY.md) for reporting vulnerabilities.

## Known limitations

- Reloading VS Code stops managed child processes; stored conversations can be resumed afterward.
- Some provider commands only exist in their native interactive terminal UI.
- Available models, limits and permission modes depend on the installed CLI, account and organization policy.
- Voice dictation depends on the official Codex Audio helper and OpenAI transcription availability.

## License

[MIT](LICENSE)
