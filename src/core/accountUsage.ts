/** Account allowance, independent of a conversation's token count or cost. */
export interface AccountUsage {
  label: string;
  detail: string;
  fetchedAt: number;
}
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const pct = (v: number) => `${Math.max(0, Math.min(100, v)).toLocaleString('en', { maximumFractionDigits: 1 })}%`;
const money = (amount: number, currency = 'USD', exponent = 2) =>
  (amount / 10 ** exponent).toLocaleString('en', { style: 'currency', currency });

export function claudeAccountUsage(response: any, now = Date.now()): AccountUsage {
  const spend = response?.rate_limits?.spend;
  const extra = response?.rate_limits?.extra_usage;
  const limit = spend?.limit?.amount_minor ?? extra?.monthly_limit;
  const used = spend?.used?.amount_minor ?? extra?.used_credits;
  if (finite(limit) && limit > 0 && finite(used)) {
    const remaining = Math.max(0, limit - used);
    const currency = spend?.limit?.currency ?? extra?.currency ?? 'USD';
    const exponent = spend?.limit?.exponent ?? extra?.decimal_places ?? 2;
    return { label: `Credits left ${pct(remaining / limit * 100)}`,
      detail: `Assigned allowance: ${money(remaining, currency, exponent)} remaining of ${money(limit, currency, exponent)}.\n${money(used, currency, exponent)} spent.`, fetchedAt: now };
  }
  return { label: 'Credits left —', detail: 'Claude did not report a finite assigned credit allowance for this account.', fetchedAt: now };
}

export function codexAccountUsage(response: any, model?: string, now = Date.now()): AccountUsage {
  const byId = response?.rateLimitsByLimitId ?? {};
  const snapshot = (Object.values(byId).find((s: any) => model && s?.normalModelSlug === model) as any)
    ?? response?.rateLimits ?? byId.codex;
  const labels: string[] = [];
  const details: string[] = [];
  for (const key of ['primary', 'secondary']) {
    const window = snapshot?.[key];
    if (!finite(window?.usedPercent)) continue;
    const minutes = window.windowDurationMins;
    const period = minutes === 10080 ? 'weekly' : minutes === 300 ? '5h'
      : finite(minutes) && minutes > 0 ? (minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`)
        : key === 'primary' ? 'primary' : 'secondary';
    const left = pct(100 - window.usedPercent);
    labels.push(`${period} ${left}`);
    details.push(`${period}: ${left} remaining${finite(window.resetsAt) ? `; resets ${new Date(window.resetsAt * 1000).toLocaleString()}` : ''}.`);
  }
  return { label: labels.length ? `Usage left ${labels.join(' · ')}` : 'Usage left —',
    detail: details.join('\n') || 'Codex did not report usage limits for this account.', fetchedAt: now };
}
