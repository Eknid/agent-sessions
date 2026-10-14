import { SlashCommands } from './sessionManager';

/*
 * Slash commands in a session tab. Three kinds:
 *  - local: handled by the extension (the headless process does not have them);
 *  - headless: forwarded to claude as a message, as Claude Code expects;
 *  - terminal-only / unknown: refused locally with a pointer to the native TUI.
 */

export interface CommandInfo {
  name: string;
  description: string;
  kind: 'local' | 'headless' | 'skill' | 'terminal';
}

export const LOCAL_COMMANDS: Record<string, string> = {
  permissions: 'Choose the permission mode for this session',
  resume: 'Resume a past conversation from this folder as a tracked session',
  exit: 'Stop this session’s agent process',
  quit: 'Stop this session’s agent process',
  help: 'List the commands available here',
  status: 'Show this session’s state, cost, tokens and context',
  cost: 'Show this session’s cost and token usage',
  native: 'Open this session in the agent’s native terminal',
};

// Descriptions for the built-ins claude reports by name only.
const BUILTIN: Record<string, string> = {
  clear: 'Start a fresh conversation',
  compact: 'Summarize the conversation to free context',
  context: 'Show context window usage',
  model: 'Switch the model',
  effort: 'Set the reasoning effort',
  fast: 'Toggle fast mode',
  init: 'Create a CLAUDE.md for this project',
  config: 'Show or change settings',
  mcp: 'Manage MCP servers',
  agents: 'Manage subagents',
  'list-agents': 'List running agents',
  'output-style': 'Set the output style',
  rename: 'Rename the conversation',
  recap: 'Summarize the session so far',
  usage: 'Show plan usage',
  'security-review': 'Review pending changes for security issues',
  'code-review': 'Review the current diff',
  review: 'Review a pull request',
  commit: 'Commit the staged changes',
  pr: 'Open a pull request',
  goal: 'Set a goal Claude keeps working towards',
  loop: 'Run a prompt on a recurring interval',
  schedule: 'Schedule a cloud agent',
  autocompact: 'Configure automatic compaction',
  'reload-skills': 'Reload skills',
  insights: 'Show session insights',
  verify: 'Verify recent changes',
  simplify: 'Simplify the changed code',
};

export function describe(name: string): string {
  return LOCAL_COMMANDS[name] ?? BUILTIN[name] ?? (name.includes(':') ? `${name.split(':')[0]} plugin` : 'skill / command');
}

export function catalogue(cmds: SlashCommands): CommandInfo[] {
  const seen = new Set<string>();
  const out: CommandInfo[] = [];
  for (const name of [...Object.keys(LOCAL_COMMANDS), ...(cmds.local ?? [])]) {
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ name, description: cmds.descriptions?.[name] ?? describe(name), kind: 'local' });
  }
  const terminalOnly = new Set(cmds.terminalOnly);
  for (const name of cmds.headless) {
    if (seen.has(name) || terminalOnly.has(name) || name.startsWith('__')) continue;
    seen.add(name);
    out.push({ name, description: cmds.descriptions?.[name] ?? describe(name), kind: cmds.skills?.includes(name) ? 'skill' : 'headless' });
  }
  if (cmds.forwardUnknown === false) for (const name of cmds.terminalOnly) {
    if (!seen.has(name)) out.push({ name, description: `${describe(name)} (native terminal)`, kind: 'terminal' });
  }
  return out;
}

/** Commands matching what was typed after `/`: prefix matches first, then any `:segment` or substring. */
export function matchCommands(all: CommandInfo[], typed: string, limit = 8): CommandInfo[] {
  const q = typed.toLowerCase();
  const rank = (c: CommandInfo): number => {
    const n = c.name.toLowerCase();
    if (n === q) return 0;
    if (n.startsWith(q)) return 1;
    if (n.split(/[:\-_]/).some((part) => part.startsWith(q))) return 2;
    if (n.includes(q)) return 3;
    return -1;
  };
  return all
    .map((c) => ({ c, r: rank(c) }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r || (a.c.kind === b.c.kind ? 0 : a.c.kind === 'local' ? -1 : 1) || a.c.name.length - b.c.name.length || a.c.name.localeCompare(b.c.name))
    .slice(0, limit)
    .map((x) => x.c);
}

export type Classified =
  | { kind: 'local'; name: string; args: string }
  | { kind: 'headless'; name: string }
  | { kind: 'unsupported'; name: string; terminalOnly: boolean }
  | { kind: 'text' };

export function classify(text: string, cmds: SlashCommands): Classified {
  const m = /^\/([\w:.-]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m) return { kind: 'text' };
  const name = m[1];
  if (LOCAL_COMMANDS[name] || cmds.local?.includes(name)) return { kind: 'local', name, args: (m[2] ?? '').trim() };
  if (cmds.terminalOnly.includes(name)) return { kind: 'unsupported', name, terminalOnly: true };
  // Without a command list yet (no claude has started) we cannot judge: let claude decide.
  if ((!cmds.headless.length && cmds.forwardUnknown !== false) || cmds.headless.includes(name)) return { kind: 'headless', name };
  // A path like /Users/... is text, not a command.
  if (name.includes('/') || name.includes('.')) return { kind: 'text' };
  return { kind: 'unsupported', name, terminalOnly: false };
}
