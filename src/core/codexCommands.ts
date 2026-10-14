export interface CodexSkill { name: string; path?: string; pluginId?: string; description: string; }

export const CODEX_COMMANDS: Record<string, string> = {
  model: 'Choose the Codex model',
  goal: 'Set a persistent goal; view, pause, resume or clear it',
  compact: 'Compact the conversation to free context',
  review: 'Review uncommitted changes, or provide review instructions',
  skills: 'List installed skills; /skills reload refreshes them',
  mcp: 'List MCP servers and their tools',
  usage: 'Show Codex account usage limits',
};

export const CODEX_TERMINAL_COMMANDS = ['plan', 'config', 'login', 'logout'];
