export const fmtTokens = (n: number): string =>
  n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(Math.round(n));

export const fmtUsd = (n: number): string => (n > 0 && n < 0.01 ? '<$0.01' : '$' + n.toFixed(2));

export function fmtSessionCost(session: { provider?: string; costAvailable?: boolean; costUsd: number }, amount = session.costUsd): string {
  if (session.costAvailable === false) return 'cost unavailable';
  return (session.provider === 'codex' ? '~' : '') + fmtUsd(amount);
}

export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h) return `${h}h ${m % 60}m`;
  if (m) return `${m}m ${s % 60}s`;
  return `${s}s`;
}
