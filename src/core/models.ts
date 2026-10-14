import { ClaudeProcess, childEnv } from '../process/claudeProcess';
import { CodexRpc } from '../process/codexRpc';
import { DEFAULT_RATES, modelLabel } from './pricing';

export type AgentProvider = 'claude' | 'codex';
export const providerLabel = (provider?: AgentProvider) => provider === 'codex' ? 'Codex' : 'Claude Code';
export interface ModelChoice {
  label: string; value: string; description?: string; detail?: string;
  configuredDefault?: boolean;
  /** False for a config value absent from the current model/list response. */
  advertised?: boolean;
  catalogDefault?: boolean;
  hidden?: boolean;
  unverified?: boolean;
  efforts?: string[];
  aliases?: string[];
}
export type ModelCatalogue = ModelChoice[] & { accountType?: string; defaultEfforts?: string[] };

// Newer models can be usable before an installed CLI's catalogue lists them.
// These fallback entries do not imply that every account has access.
const KNOWN_CODEX_MODELS: ModelChoice[] = [
  { label: 'GPT-6.1-Sol', value: 'gpt-6.1-sol' },
  { label: 'GPT-6-Astra', value: 'gpt-6-astra' },
  { label: 'GPT-6-Sol', value: 'gpt-6-sol' },
  { label: 'GPT-6-Luna', value: 'gpt-6-luna' },
];

function codexModelLabel(value: string): string {
  return KNOWN_CODEX_MODELS.find((model) => model.value === value)?.label ?? value;
}

/** Codex's live catalogue determines availability; known IDs remain optional unverified entries. */
export function modelChoices(provider: AgentProvider, discovered: ModelCatalogue, defaultModel = '', custom: string[] = []): ModelChoice[] {
  if (provider === 'codex') return codexModelChoices(discovered, defaultModel, custom);
  const configuredDefault = discovered.find((model) => model.configuredDefault);
  const defaultLabel = defaultModel ? `Default (${defaultModel})` : configuredDefault ? `${providerLabel(provider)} default (${configuredDefault.label})` : `${providerLabel(provider)} default`;
  const out: ModelChoice[] = [{ label: defaultLabel, value: defaultModel }];
  const seen = new Set([defaultModel]);
  const add = (m: ModelChoice) => { if (m.value && !seen.has(m.value)) { seen.add(m.value); out.push(m); } };
  discovered.forEach(add);
  if (provider === 'claude') {
    for (const value of Object.keys(DEFAULT_RATES).filter((id) => id.startsWith('claude-'))) {
      add({ label: modelLabel(value), value, description: 'Known version · availability depends on your account', detail: value });
    }
    for (const value of ['opus', 'sonnet', 'haiku']) add({ label: `${modelLabel(value)} (latest alias)`, value, detail: value });
  }
  custom.forEach((value) => add({ label: modelLabel(value), value, description: 'Configured model', detail: value }));
  out.push({ label: 'Custom model ID…', value: '__custom__', description: 'Enter an exact model ID or deployment name' });
  return out;
}

function codexModelChoices(discovered: ModelCatalogue, defaultModel: string, custom: string[]): ModelChoice[] {
  const configured = defaultModel || discovered.find((model) => model.configuredDefault)?.value;
  const catalog = discovered.filter((model) => model.advertised !== false && (!model.hidden || model.value === configured || custom.includes(model.value)));
  const configuredMissing = Boolean(configured && !catalog.some((model) => model.value === configured));
  const out: ModelChoice[] = [];
  const seen = new Set<string>();
  const add = (model: ModelChoice) => {
    if (model.value && !seen.has(model.value)) { seen.add(model.value); out.push(model); }
  };
  out.push({ label: configured ? `Default (${codexModelLabel(configured)})` : 'Codex default',
    value: configured || '', unverified: configuredMissing,
    description: configuredMissing ? 'Configured model is not in the current Codex catalogue' : catalog.length ? undefined : 'Model availability could not be verified',
    detail: configuredMissing ? 'Codex may reject this model for your current login.' : undefined });
  if (configured) seen.add(configured);
  catalog.forEach(add);
  const unverified = (model: ModelChoice) => ({ ...model, unverified: true,
    description: model.configuredDefault || model.value === defaultModel ? 'Configured default · not advertised by Codex' : 'Not advertised by Codex',
    detail: `${model.value} — may be unsupported with your current login. API availability and ChatGPT Codex access can differ.` });
  discovered.filter((model) => model.advertised === false).forEach((model) => add(unverified(model)));
  if (defaultModel) add(unverified({ label: codexModelLabel(defaultModel), value: defaultModel }));
  KNOWN_CODEX_MODELS.forEach((model) => add(unverified(model)));
  custom.forEach((value) => add(unverified({ label: codexModelLabel(value), value })));
  out.push({ label: 'Custom model ID…', value: '__custom__', description: 'Enter an exact ID; access depends on your provider and login' });
  return out;
}

/** Discover the installed CLI's catalogue without sending a prompt or spending tokens. */
export async function discoverModels(provider: AgentProvider, command: string, cwd: string, extraArgs: string[] = []): Promise<ModelCatalogue> {
  if (provider === 'codex') {
    const rpc = new CodexRpc();
    // Discovery has a shorter timeout than interactive operations.
    const timer = setTimeout(() => rpc.kill(), 15_000);
    rpc.start({ command, args: ['app-server', ...extraArgs], cwd, env: childEnv() });
    try {
      await rpc.initialize();
      const out: ModelChoice[] = [];
      let cursor: string | null = null;
      const cursors = new Set<string>();
      do {
        const page = await rpc.request('model/list', { includeHidden: true, limit: 100, cursor });
        for (const m of page.data ?? []) {
          out.push({ label: m.displayName || m.model || m.id, value: m.model || m.id, advertised: true, catalogDefault: Boolean(m.isDefault), hidden: Boolean(m.hidden), efforts: m.supportedReasoningEfforts?.map((e: any) => e.reasoningEffort), description: m.hidden ? 'Additional model reported by Codex' : m.isDefault ? 'Recommended by Codex' : 'Reported by Codex', detail: m.description });
        }
        cursor = page.nextCursor;
        if (cursor && cursors.has(cursor)) throw new Error('Codex returned a repeated model cursor');
        if (cursor) cursors.add(cursor);
      } while (cursor);
      // model/list may advertise an older catalogue default than the actual workspace configuration.
      try {
        const response = await rpc.request('config/read', { cwd }, 5000);
        const configured = response.config?.model;
        if (typeof configured === 'string' && configured.trim()) {
          const existing = out.find((model) => model.value === configured);
          if (existing) { existing.configuredDefault = true; existing.description = 'Configured Codex default'; }
          else out.push({ label: codexModelLabel(configured), value: configured, advertised: false, configuredDefault: true, description: 'Configured default · not advertised by Codex', detail: configured });
        }
      } catch { /* Older CLIs may not expose config/read; their catalogue is still useful. */ }
      try {
        const response = await rpc.request('account/read', { refreshToken: false }, 5000);
        (out as ModelCatalogue).accountType = response.account?.type;
      } catch { /* Older/custom providers may not expose account information. */ }
      return out;
    } finally { clearTimeout(timer); rpc.kill(); }
  }
  const proc = new ClaudeProcess();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('Claude model discovery timed out')), 15_000);
    const finish = (err?: Error, models?: ModelChoice[]) => {
      clearTimeout(timer);
      proc.removeAllListeners();
      proc.kill();
      if (err) reject(err); else resolve(models ?? []);
    };
    proc.on('spawnError', (err: Error) => finish(err));
    proc.on('exit', () => finish(new Error('Claude exited before returning its model catalogue')));
    proc.on('event', (ev) => {
      if (ev.type !== 'control_response' || ev.response?.request_id !== 'models') return;
      if (ev.response.subtype === 'error') return finish(new Error(ev.response.error));
      const models = ev.response.response?.models ?? ev.response.response?.supported_models;
      if (!Array.isArray(models)) return finish(new Error('This Claude CLI does not expose a model catalogue'));
      const catalogue = models.filter((m: any) => m.value !== 'default').map((m: any) => {
        // Resolve rolling aliases; preserve explicit IDs, even when the provider redirects them.
        const value = /^(opus|sonnet|haiku|fable)$/.test(m.value) ? m.resolvedModel || m.value : m.value;
        return { label: m.displayName || modelLabel(value), value, aliases: [m.value, m.resolvedModel].filter(Boolean), efforts: m.supportsEffort === false ? [] : m.supportedEffortLevels, description: m.resolvedModel && m.resolvedModel !== value ? `Provider redirects to ${modelLabel(m.resolvedModel)}` : 'Reported by Claude Code', detail: value };
      }) as ModelCatalogue;
      catalogue.defaultEfforts = models.find((m: any) => m.value === 'default')?.supportedEffortLevels;
      finish(undefined, catalogue);
    });
    proc.start({ command, args: ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', ...extraArgs], cwd, env: childEnv() });
    proc.send({ type: 'control_request', request_id: 'models', request: { subtype: 'initialize' } });
  });
}
