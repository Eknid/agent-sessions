# Changelog

All notable changes to Agent Sessions are documented in this file.

## 0.11.11 — 2026-10-30

- Fixed sessions disappearing from the list when several VS Code windows were open: each session now has its own metadata file, so one window can no longer overwrite the sessions of another.
- Sessions lost this way come back on the next start, rebuilt from their logs and filed in the archive.
- A session removed in one window no longer reappears when another window saves it.

## 0.11.10 — 2026-10-30

- Fixed copying agent output from session tabs on recent VS Code versions: selected text and code-block **Copy** now go through the VS Code clipboard.
- Sessions running in one VS Code window now show live in every other window: transcript, state, pending approvals and queue. Messages, approvals, interrupts and settings changes made in another window are carried out by the window that runs the session.
- Opening a second window no longer marks the first window's running sessions as ended.

## 0.11.9 — 2026-10-18

- Imported sessions and transcripts saved by Claude Sessions without overwriting current sessions or changing the old archive.
- Restored session and board tabs created before the extension was renamed.

## 0.11.8 — 2026-10-18

- Added `@` file suggestions in the chat composer, with fuzzy path filtering and keyboard navigation.
- Fixed the activity-bar view on VS Code versions that reserve the `agentSessions` container identifier.
- Made Claude Auto mode and Codex Approve for me the defaults for new sessions.

## 0.11.7 — 2026-10-14

- Prepared the first public release under the vendor-neutral Agent Sessions name.
- Added shared session management for Claude Code and OpenAI Codex.
- Added streaming chat, approvals, questions, queued prompts and image attachments.
- Added subagent inspection, session resume and fork, native terminal handoff and session-ID copying.
- Added provider model controls, usage windows, context tracking and cost estimates.
- Added voice dictation through the Codex Audio helper.
- Added public documentation, contribution and security policies, licensing and CI checks.
