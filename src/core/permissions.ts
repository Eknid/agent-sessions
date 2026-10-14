import type { AgentProvider } from './models';

export interface PermissionChoice { value: string; label: string; detail: string; }
export interface PermissionView extends PermissionChoice {}
export interface CodexPermissions {
  approvalPolicy: 'on-request' | 'untrusted' | 'never';
  approvalsReviewer?: 'user' | 'auto_review';
  sandbox: 'workspace-write' | 'read-only' | 'danger-full-access';
}

const CLAUDE: PermissionChoice[] = [
  { value: 'default', label: 'Ask for approval', detail: 'Ask you before tools that need permission.' },
  { value: 'auto', label: 'Auto mode', detail: 'Claude assesses actions and asks when automatic approval is not allowed.' },
  { value: 'acceptEdits', label: 'Accept edits', detail: 'Allow file edits automatically; other actions may still need approval.' },
  { value: 'plan', label: 'Plan mode', detail: 'Explore and plan without executing changes.' },
  { value: 'dontAsk', label: 'Never ask', detail: 'Deny actions that would need an approval prompt.' },
  { value: 'bypassPermissions', label: 'Full access', detail: 'Bypass Claude permission checks for tools and commands.' },
];
const CODEX: PermissionChoice[] = [
  { value: 'ask', label: 'Ask for approval', detail: 'Work in the workspace sandbox; ask you before crossing its boundaries.' },
  { value: 'auto', label: 'Approve for me', detail: 'Keep the workspace sandbox and route eligible requests to Codex automatic review.' },
  { value: 'readOnly', label: 'Read only', detail: 'Read files; ask you before changes or actions beyond the read-only sandbox.' },
  { value: 'fullAccess', label: 'Full access', detail: 'Run without the Codex sandbox or approval prompts.' },
];

export function permissionChoices(provider: AgentProvider): PermissionChoice[] {
  return (provider === 'codex' ? CODEX : CLAUDE).map((choice) => ({ ...choice }));
}

export function codexPermissionPreset(value: string): CodexPermissions {
  const presets: Record<string, CodexPermissions> = {
    ask: { approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'workspace-write' },
    auto: { approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', sandbox: 'workspace-write' },
    readOnly: { approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'read-only' },
    fullAccess: { approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: 'danger-full-access' },
  };
  if (!presets[value]) throw new Error('Invalid Codex permission mode.');
  return { ...presets[value] };
}

export function claudePermissionView(mode = 'default'): PermissionView {
  const value = mode === 'manual' ? 'default' : mode;
  return CLAUDE.find((choice) => choice.value === value) ?? { value, label: 'Custom permissions', detail: `Claude mode: ${mode}` };
}

export function codexPermissionView(settings: { approvalPolicy?: any; approvalsReviewer?: string; sandbox?: string; sandboxPolicy?: any }): PermissionView {
  const types: Record<string, string> = { workspaceWrite: 'workspace-write', readOnly: 'read-only', dangerFullAccess: 'danger-full-access' };
  const sandbox = settings.sandboxPolicy ? types[settings.sandboxPolicy.type] ?? settings.sandboxPolicy.type : settings.sandbox;
  const reviewer = settings.approvalsReviewer ?? 'user';
  // Extra roots and network access represent custom permissions, even when the policy has the same base type.
  const policy = settings.sandboxPolicy;
  const custom = policy?.networkAccess === true || (policy?.writableRoots?.length ?? 0) > 1;
  if (!custom) for (const choice of CODEX) {
    const preset = codexPermissionPreset(choice.value);
    if (preset.approvalPolicy === settings.approvalPolicy && preset.approvalsReviewer === reviewer && preset.sandbox === sandbox) return choice;
  }
  return { value: 'custom', label: 'Custom permissions',
    detail: `Sandbox: ${sandbox ?? 'configured'} · Approvals: ${typeof settings.approvalPolicy === 'string' ? settings.approvalPolicy : 'custom'} · Reviewer: ${reviewer}` };
}

export function codexSandboxPolicy(sandbox: CodexPermissions['sandbox'], cwd: string) {
  if (sandbox === 'danger-full-access') return { type: 'dangerFullAccess' };
  if (sandbox === 'read-only') return { type: 'readOnly', networkAccess: false };
  return { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
}
