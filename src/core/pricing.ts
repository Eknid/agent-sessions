import { Usage } from './events';

/** $ per million tokens. Used only for live estimates: the authoritative cost comes from `result.modelUsage`. */
export interface Rates {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  contextWindow: number;
  longContextThreshold?: number;
  longContext?: Pick<Rates, 'input' | 'output' | 'cacheRead' | 'cacheWrite5m' | 'cacheWrite1h'>;
}

const rates = (input: number, output: number, cacheRead: number, contextWindow: number): Rates => ({
  input,
  output,
  cacheWrite5m: input * 1.25,
  cacheWrite1h: input * 2,
  cacheRead,
  contextWindow,
});

const openaiRates = (input: number, output: number, cacheRead: number, longContext = true): Rates => {
  const r = { ...rates(input, output, cacheRead, 1_050_000), cacheWrite1h: input * 1.25 };
  return longContext ? {
    ...r, longContextThreshold: 272_000,
    longContext: { input: input * 2, output: output * 1.5, cacheRead: cacheRead * 2, cacheWrite5m: input * 2.5, cacheWrite1h: input * 2.5 },
  } : r;
};

// Anthropic first-party list prices, cached 2026-09-25.
export const DEFAULT_RATES: Record<string, Rates> = {
  'claude-fable-5-1': rates(10, 50, 0.25, 1_000_000),
  'claude-fable-5': rates(10, 50, 1, 1_000_000),
  'claude-opus-5-5': rates(4, 20, 0.2, 1_000_000),
  'claude-opus-5': rates(5, 25, 0.5, 1_000_000),
  'claude-opus-4-8': rates(5, 25, 0.5, 1_000_000),
  'claude-opus-4-7': rates(5, 25, 0.5, 1_000_000),
  'claude-opus-4-6': rates(5, 25, 0.5, 1_000_000),
  'claude-opus-4-5': rates(5, 25, 0.5, 200_000),
  'claude-opus-4-1': rates(15, 75, 1.5, 200_000),
  'claude-sonnet-5-5': rates(2, 10, 0.2, 1_000_000),
  'claude-sonnet-5': rates(2, 10, 0.2, 1_000_000),
  'claude-sonnet-4-6': rates(3, 15, 0.3, 1_000_000),
  'claude-sonnet-4-5': rates(3, 15, 0.3, 200_000),
  'claude-haiku-4-5': rates(1, 5, 0.1, 200_000),
  // OpenAI Standard API prices, verified 2026-10-07. Each value is $/million tokens.
  // https://developers.openai.com/api/docs/pricing?latest-pricing=standard
  // Individual model pages supply older model rates and the >272K prompt threshold.
  'gpt-6-astra': openaiRates(10, 50, 1),
  'gpt-6.1-sol': openaiRates(2, 10, 0.1),
  'gpt-6-sol': openaiRates(2, 10, 0.2),
  'gpt-6-luna': openaiRates(0.1, 0.5, 0.01),
  'gpt-5.6-sol': openaiRates(4, 20, 0.4),
  'gpt-5.6': openaiRates(4, 20, 0.4),
  'gpt-5.6-terra': openaiRates(2, 12, 0.2),
  'gpt-5.6-luna': openaiRates(0.2, 1.2, 0.02),
  'gpt-5.5': openaiRates(5, 30, 0.5),
  'gpt-5.3-codex': { ...openaiRates(1.75, 14, 0.175, false), contextWindow: 400_000, cacheWrite5m: 1.75, cacheWrite1h: 1.75 },
};

// Family fallback for ids the table does not know yet: price as the current generation.
const FAMILY_FALLBACK: [RegExp, string][] = [
  [/fable/, 'claude-fable-5-1'],
  [/opus/, 'claude-opus-5-5'],
  [/sonnet/, 'claude-sonnet-5-5'],
  [/haiku/, 'claude-haiku-4-5'],
];

/** `claude-haiku-4-5-20251001` → `claude-haiku-4-5`, `claude-opus-5[1m]` → `claude-opus-5`. */
export function canonicalModel(id: string | undefined): string {
  if (!id) return 'unknown';
  return id.toLowerCase().replace(/\[[^\]]*\]$/, '').replace(/-(?:\d{8}|\d{4}-\d{2}-\d{2})$/, '').replace(/^(anthropic\.|us\.anthropic\.|openai\/)/, '');
}

export type FamilyName = 'fable' | 'opus' | 'sonnet' | 'haiku' | 'other';

export function modelFamily(id: string | undefined): FamilyName {
  const c = canonicalModel(id);
  for (const f of ['fable', 'opus', 'sonnet', 'haiku'] as const) if (c.includes(f)) return f;
  return 'other';
}

/** `claude-opus-5-5` → `Opus 5.5`; aliases like `haiku` → `Haiku`; nothing known → `—`. */
export function modelLabel(id: string | undefined): string {
  if (!id) return '—';
  const c = canonicalModel(id);
  if (/^(fable|opus|sonnet|haiku)$/.test(c)) return c.charAt(0).toUpperCase() + c.slice(1);
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?$/.exec(c);
  if (!m) return c;
  const name = m[1].charAt(0).toUpperCase() + m[1].slice(1);
  return m[3] ? `${name} ${m[2]}.${m[3]}` : `${name} ${m[2]}`;
}

export class PriceTable {
  private table: Record<string, Rates>;

  constructor(overrides: Record<string, Partial<Rates>> = {}) {
    this.table = { ...DEFAULT_RATES };
    for (const [id, o] of Object.entries(overrides)) {
      const base = this.table[canonicalModel(id)] ?? rates(0, 0, 0, 200_000);
      this.table[canonicalModel(id)] = { ...base, ...o };
    }
  }

  rates(model: string | undefined): Rates {
    const c = canonicalModel(model);
    const hit = this.table[c];
    if (hit) return hit;
    for (const [re, id] of FAMILY_FALLBACK) if (re.test(c)) return this.table[id];
    return rates(0, 0, 0, 0);
  }

  hasRates(model: string | undefined): boolean {
    const c = canonicalModel(model);
    return Boolean(this.table[c] || FAMILY_FALLBACK.some(([re]) => re.test(c)));
  }

  contextWindow(model: string | undefined): number {
    if (model && /\[1m\]$/i.test(model)) return 1_000_000;
    return this.rates(model).contextWindow;
  }

  cost(model: string | undefined, u: Usage, promptTokens?: number): number {
    const base = this.rates(model);
    const context = promptTokens ?? (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    const r = base.longContext && base.longContextThreshold !== undefined && context > base.longContextThreshold ? base.longContext : base;
    const cacheWrite = u.cache_creation_input_tokens ?? 0;
    const w1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
    const w5m = Math.max(0, cacheWrite - w1h);
    return (
      ((u.input_tokens ?? 0) * r.input +
        (u.output_tokens ?? 0) * r.output +
        w5m * r.cacheWrite5m +
        w1h * r.cacheWrite1h +
        (u.cache_read_input_tokens ?? 0) * r.cacheRead) /
      1_000_000
    );
  }
}
