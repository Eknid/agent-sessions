# Agent Sessions: Product Overview

*An onboarding guide for product and engineering managers. It covers what the product is, who
it is for, how it behaves and why it was built this way. Implementation details are left out.*

Current version: **0.11.9** (October 2026) · License: MIT · Status: early public release

---

## 1. What it is, in one paragraph

Agent Sessions is a **VS Code extension that works as mission control for AI coding agents**.
Developers increasingly run several AI agents at once, such as Claude Code and OpenAI Codex,
each working on a different task or repository. Each agent normally lives in its own terminal
window. Agent Sessions puts all of them in one place. Users see what each agent is doing, which
ones are blocked waiting for a human, what each one costs, and they can chat with any of them
without leaving the editor.

> Agent Sessions is an independent open-source project. It is not affiliated with Anthropic or
> OpenAI. It does not ship its own AI. It drives the official agent tools the user has already
> installed and signed into.

## 2. The problem it solves

| Pain today                                                                | What Agent Sessions does                                                                    |
|---------------------------------------------------------------------------|---------------------------------------------------------------------------------------------|
| Agents run in scattered terminal tabs, so it is hard to know which is busy | One sidebar and one board list every session with a live status                             |
| An agent silently waits for permission and nobody notices for an hour     | A **Waiting for you** state, a badge count and a desktop notification                       |
| No visibility into spend while working                                    | Live token, context-window and cost estimates per session and per subagent                  |
| Different tools from different vendors, each with its own UI              | One consistent chat experience for Claude Code and Codex, designed to add more vendors      |
| Closing a terminal kills the work                                         | Closing a chat tab does not stop the agent. Conversations can be resumed, forked or archived |

## 3. Who it is for

- **Primary user:** a software developer who already uses Claude Code and/or OpenAI Codex and
  runs more than one agent session in parallel.
- **Secondary user:** power users and team leads who care about cost and usage visibility
  across sessions and accounts.
- **Not for:** people without one of the supported agent tools. The extension does not supply
  an AI model, an account or credits.

## 4. Supported agents (providers)

| Provider         | Requirement                                                         | Provider-specific extras                                                                     |
|------------------|---------------------------------------------------------------------|----------------------------------------------------------------------------------------------|
| **Claude Code**  | Claude Code CLI installed and signed in                             | Permission modes, account credit display, nested subagents, resume and fork                  |
| **OpenAI Codex** | Codex CLI installed and signed in (or the official Codex extension) | Model discovery, reasoning effort, sandbox controls, usage windows, skills, goals, review, compaction |

Users pick the provider when they create a session. Both providers appear side by side in
the same list and board.

---

## 5. How it works (user's point of view)

### 5.1 Core concepts

| Concept            | Meaning                                                                                                   |
|--------------------|-----------------------------------------------------------------------------------------------------------|
| **Session**        | One agent conversation bound to a folder on disk, a provider and a model. It has a name the user chooses. |
| **Subagent**       | A helper agent that the main agent spawns, in the foreground or background. Shown nested under its session. |
| **Turn**           | One round: the user sends a message and the agent works until it replies.                                 |
| **Pending request** | The agent asks for permission to use a tool or asks the user a question. The session is blocked until answered. |
| **Queue**          | Messages typed while the agent is busy. They are sent in order when the turn ends.                       |

### 5.2 The three statuses

Every session is always in one of three user-facing states. This is the central idea of the
product.

| Status              | What it means                                                         | Finer labels shown                          |
|---------------------|-----------------------------------------------------------------------|---------------------------------------------|
| **Running**         | The agent is working                                                  | Running                                     |
| **Waiting for you** | The agent is blocked on a human: a permission prompt or a question    | Needs permission · Asking you a question    |
| **Done**            | The turn is finished, or the process has ended                        | Ready (nothing sent yet) · Ended · Error    |

Inside **Waiting for you**, the session that has waited longest is listed first. Inside the
other groups, the most recently active session is listed first.

### 5.3 The main surfaces

| Surface                     | Where                         | Purpose                                                                                       |
|-----------------------------|-------------------------------|-----------------------------------------------------------------------------------------------|
| **Sessions sidebar**        | VS Code activity bar          | Tree of sessions grouped by status or by Git repository, with subagents folded inside. Archived sessions sit at the bottom. |
| **Metrics panel**           | Under the sidebar             | Summary cards (active, waiting, running agents, total cost and tokens) and a drill-down of cost per subagent for the selected session. |
| **Board**                   | Editor tab                    | Kanban view with columns Running / Waiting / Done, optionally one lane per repository. Users can approve, deny or answer requests straight from a card. |
| **Session (chat) tab**      | Editor tab, detachable        | Full chat: streamed replies, reasoning summaries, tool calls and output, approval cards, a question picker, a queue and attachments. |
| **Status bar and badge**    | VS Code chrome                | "N running · N waiting" counts and a badge with the number of sessions that need you.         |
| **Notifications**           | VS Code toasts                | Raised when a background session needs permission, asks a question or finishes. They are skipped if the user is already looking at that session. |

### 5.4 A typical flow

1. The user opens **Agent Sessions** from the activity bar and clicks **New Session**, or
   right-clicks a folder and picks **New Agent Session Here**.
2. They choose a **provider → folder → model → name**.
3. A chat tab opens and they send the first message.
4. They can close the tab and start more sessions. The agents keep working.
5. When an agent needs something, the session moves to **Waiting for you** and a notification
   appears. The user answers from the chat, the board or the metrics panel.
6. When the work is finished they **archive** the session, or **fork** it to try another
   direction from the same point.

---

## 6. Feature inventory

### 6.1 Session lifecycle

| Feature                        | Description                                                                                       |
|--------------------------------|---------------------------------------------------------------------------------------------------|
| New session                    | Choose provider, folder, model and name. Also available from the Explorer right-click menu.      |
| Resume past conversation       | Import a conversation started in the agent's own terminal (outside the extension) as a tracked session. |
| Resume session                 | Restart a stopped session and continue the same conversation.                                     |
| Fork conversation              | Copy a conversation at its current point into a new, independent session.                         |
| Archive / unarchive            | Put a session away. Archiving stops the agent and keeps the history.                              |
| Rename                         | Change the display name.                                                                          |
| Remove from list               | Delete the session and its stored history from the extension.                                     |
| Interrupt turn                 | Stop the current turn (`Esc`) without killing the session.                                        |
| Stop process                   | Kill the agent process.                                                                           |
| Open in native terminal        | Hand the same conversation over to the vendor's own terminal UI (`/native`).                      |
| Copy session ID                | Copy the vendor's own conversation ID for use in other tools.                                     |
| Change Codex model             | Switch model mid-conversation without losing history.                                             |

### 6.2 Chat experience

- Streaming replies, rendered as Markdown, with reasoning summaries, tool calls and tool output.
- **Approval cards:** Allow, Always allow (where the agent offers it) or Deny, with optional
  feedback.
- **Question cards:** when the agent asks a multiple-choice question, the user picks an answer
  or skips it.
- **Message queue:** type while the agent works. Queued messages can be pulled back before
  they are sent.
- **Attachments:** paste or pick images. Other dropped files are referenced by path.
- **`/` commands:** a searchable list of the commands and skills available for that provider.
- **`@` mentions:** a fuzzy-searchable list of files in the session folder.
- **Voice dictation:** a microphone button turns speech into text in the prompt box.
- **Links:** web links open in the browser and file paths open in the editor.
- **Subagent transcripts:** open any subagent's conversation in its own tab.
- In-chat controls for **permission mode** and **reasoning effort**.

### 6.3 Commands inside the chat

There are three kinds of commands, and the product decides which applies:

| Kind                                   | Examples                                                               | Behaviour                                                       |
|----------------------------------------|------------------------------------------------------------------------|-----------------------------------------------------------------|
| **Handled by the extension**           | `/help`, `/status`, `/cost`, `/resume`, `/permissions`, `/exit`, `/native` | Answered locally                                                |
| **Forwarded to the agent**             | `/compact`, `/model`, `/review`, `/goal`, skills, plugin commands      | Passed to the agent through its supported interface             |
| **Terminal-only**                      | Commands that need the vendor's interactive UI                         | Refused, with a pointer to `/native`                            |

Codex-only extras: **persistent goals** (set, pause, clear; interrupting a turn also pauses an
active goal), **conversation compaction** and **inline code review**.

### 6.4 Monitoring, usage and cost

- **Context usage:** how full the model's context window is, per session and per subagent.
- **Tokens:** input, output and cache, per session and per subagent.
- **Estimated cost:** live estimates from a built-in price list. These are replaced by the
  vendor's own figure when the vendor reports one. Users can override prices in settings.
- **Account limits:**
  - Claude: credits left out of the assigned allowance.
  - Codex: usage left in the rolling windows (for example the 5-hour and weekly limits), with
    reset times.

### 6.5 Organisation

- Group the sidebar by **status** (default) or by **Git repository**. Sessions in subfolders and
  worktrees are grouped under their repository.
- Filter by state, collapse all, and use **Show Sessions Waiting for You** as a quick picker.

---

## 7. Permissions and safety model

Agents can edit files and run commands, so permission handling is a core product concern. The
extension exposes each vendor's own safety controls with plain-language labels. It does not
invent its own.

**Claude Code modes**

| Mode             | What it does                                                         |
|------------------|----------------------------------------------------------------------|
| Ask for approval | Asks before tools that need permission                               |
| **Auto mode**    | Claude assesses actions and asks only when needed (**default**)      |
| Accept edits     | File edits allowed automatically; other actions may still ask        |
| Plan mode        | Explore and plan only, no changes                                    |
| Never ask        | Deny anything that would need approval                              |
| Full access      | Bypass all permission checks                                         |

**Codex modes**

| Mode               | What it does                                                                          |
|--------------------|---------------------------------------------------------------------------------------|
| Ask for approval   | Works inside the project sandbox and asks before crossing it                          |
| **Approve for me** | Same sandbox. Eligible requests go to Codex's automatic reviewer (**default**)        |
| Read only          | Can read files and asks before any change                                             |
| Full access        | No sandbox, no prompts                                                                |

Users can change the mode per session at any time from the chat tab.

---

## 8. Key product decisions (and why)

| #  | Decision                                                                                   | Rationale                                                                                                   |
|----|--------------------------------------------------------------------------------------------|-------------------------------------------------------------------------------------------------------------|
| 1  | **Vendor-neutral.** The product was renamed from "Claude Sessions" to "Agent Sessions" in 0.11.7. | Users mix vendors. One shared session model lets new providers be added without redesigning the UI.         |
| 2  | **Drive the official CLIs** instead of calling the AI APIs directly                        | No API keys to manage. Users keep their existing subscriptions, sign-in and org policies, and get the vendor's own tools and safety features. |
| 3  | **Three statuses only:** Running, Waiting for you, Done                                    | The question users ask is "who needs me?". Finer detail is a secondary label.                               |
| 4  | **Closing a tab never stops an agent**                                                     | Tabs are just windows onto a session. Long tasks survive while users move around the editor.               |
| 5  | **Everything is recorded in a per-session event log**                                      | Sessions survive a VS Code restart: the history is replayed and the conversation can be resumed.           |
| 6  | **Safe-but-productive defaults** (Claude *Auto*, Codex *Approve for me*), changed in 0.11.8 | Reduces approval fatigue while keeping the vendor's sandbox and judgement in the loop.                     |
| 7  | **Defer to the native terminal** for anything the extension can't do well                  | Avoids re-implementing every vendor feature. `/native` is always the escape hatch.                          |
| 8  | **Costs are clearly labelled estimates**                                                   | Subscription plans, regional pricing and tool fees differ. Vendor-reported totals win when available.      |
| 9  | **No telemetry or analytics** of its own                                                   | Privacy and trust for an open-source developer tool. Data goes only to the provider the user chose.        |
| 10 | **Non-destructive migration** from the old Claude Sessions extension (0.11.9)              | Old history is copied, never moved or overwritten, so users can't lose data during the rename.             |
| 11 | **Tests never call paid services**                                                         | Fake agent processes keep CI deterministic and free. A real end-to-end test is opt-in.                    |

## 9. Data and privacy

- Session lists and conversation logs are stored **locally**, in VS Code's extension storage.
- Credentials stay with the vendor CLIs and are never written to session logs.
- Prompts and attachments go **only** to the provider selected for that session.
- **Voice audio is sent to OpenAI's transcription service** through the user's Codex sign-in,
  even when the active chat is a Claude session. Audio is not saved in the session log.
- Session logs can contain prompts, code, file paths and command output. The security policy
  asks users to scrub them before sharing diagnostics.

## 10. Configuration at a glance

All settings live under `agentSessions.*` in VS Code Settings.

| Area           | Settings                                                                          |
|----------------|-----------------------------------------------------------------------------------|
| General        | Default provider, grouping (status / repository), notifications on/off            |
| Claude Code    | CLI path, default model, extra models, default permission mode, extra arguments  |
| Codex          | CLI path, default model, extra models, approval policy, sandbox, extra arguments |
| Cost           | Price overrides per model                                                         |

## 11. Requirements and distribution

- VS Code **1.90+**.
- At least one of: Claude Code CLI or OpenAI Codex CLI, installed and signed in.
- Voice dictation needs the **Codex Audio helper** that ships with the official Codex extension.
- Distribution today is a **packaged VSIX file** or a build from source. The repository is
  public on GitHub (`Eknid/agent-sessions`). CI runs tests on every change.

## 12. Known limitations

- **Reloading VS Code stops running agents.** History is kept and sessions can be resumed, but
  in-flight work is interrupted.
- Some vendor commands exist only in the vendor's terminal UI. These are reachable through
  `/native`.
- Available models, limits and permission modes depend on the user's CLI version, account and
  organisation policy.
- Cost figures are estimates and depend on a built-in price list that must be kept up to date.
- Voice depends on the Codex helper and on OpenAI's transcription service being available.

## 13. Release history

| Version | Date       | Highlights                                                                                                     |
|---------|------------|----------------------------------------------------------------------------------------------------------------|
| 0.11.7  | 2026-10-14 | First public release under the vendor-neutral name. Claude Code + Codex, chat, approvals, subagents, resume/fork, usage and cost, voice. |
| 0.11.8  | 2026-10-18 | `@` file mentions. Fix for the activity-bar view on some VS Code versions. Auto / Approve-for-me become the defaults. |
| 0.11.9  | 2026-10-18 | Imports history from the old *Claude Sessions* extension without overwriting anything. Restores tabs opened before the rename. |

## 14. Open topics worth a PM/EM's attention

These are observations from reading the repository, not decisions that have been made.

1. **Marketplace publishing.** The extension ships only as a VSIX today. Publishing to the VS
   Code Marketplace (and Open VSX) is the obvious next step for reach.
2. **Price list maintenance.** Cost estimates rely on hard-coded vendor prices, last checked in
   September and October 2026. Someone should own refreshing them when vendors change prices or
   release models.
3. **Voice dictation dependency.** Voice relies on the Codex extension's audio helper and on an
   OpenAI service used the way the official Codex web client uses it. This is not a documented
   public API, so it could break without notice. Treat it as a "best-effort" feature.
4. **Surviving a reload.** Agents stopping on window reload is the most visible gap in the
   "sessions keep running" promise.
5. **More providers.** The architecture is designed for this. Candidates and priority are a
   product decision.
6. **Docs drift.** The README install snippet still names the 0.11.8 package while the
   extension is at 0.11.9, and the 0.11.9 changes are not yet committed.
