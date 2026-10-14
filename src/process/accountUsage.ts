import { ClaudeProcess, SpawnSpec } from './claudeProcess';
import { CodexRpc } from './codexRpc';
import { AgentProvider } from '../core/models';

/** Read account limits even when the conversation is stopped; never start a model turn. */
export async function readAccountUsage(provider: AgentProvider, spec: SpawnSpec, register: (process: ClaudeProcess | CodexRpc, add: boolean) => void): Promise<any> {
  const proc = provider === 'codex' ? new CodexRpc() : new ClaudeProcess();
  register(proc, true);
  const timeout = setTimeout(() => proc.kill(), 20_000);
  try {
    proc.start(spec);
    if (proc instanceof CodexRpc) {
      await proc.initialize();
      return await proc.request('account/rateLimits/read', {}, 15_000);
    }
    return await proc.requestControl({ subtype: 'get_usage', skip_behaviors: true });
  } finally { clearTimeout(timeout); proc.kill(); register(proc, false); }
}
