#!/usr/bin/env node
'use strict';
const fs = require('fs');
const { randomUUID } = require('crypto');
const readline = require('readline');
const path = require('path');
const emit = (event) => process.stdout.write(JSON.stringify(event) + '\n');
const notify = (method, params) => emit({ method, params });
const reply = (id, result) => emit({ id, result });
let threadId, turnId, pending, goal, turn = 0;
const countPath = (id) => process.env.FAKE_CODEX_STATE_DIR && path.join(process.env.FAKE_CODEX_STATE_DIR, `${id}.count`);
const readCount = (id) => countPath(id) && fs.existsSync(countPath(id)) ? Number(fs.readFileSync(countPath(id), 'utf8')) : 0;
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const ev = JSON.parse(line);
  if (process.env.FAKE_CODEX_LOG) fs.appendFileSync(process.env.FAKE_CODEX_LOG, line + '\n');
  const p = ev.params || {};
  if (!ev.method && pending && ev.id === pending.id) {
    const allowed = ev.result.decision === 'accept' || !!ev.result.answers || !!ev.result.permissions?.network;
    notify('item/completed', { threadId, turnId, item: { type: 'commandExecution', id: 'cmd-' + turn, command: 'echo hi', aggregatedOutput: allowed ? 'hi' : 'denied', status: allowed ? 'completed' : 'declined', exitCode: allowed ? 0 : 1 } });
    pending = null;
    finish(allowed ? 'approved' : 'denied');
    return;
  }
  switch (ev.method) {
    case 'initialize': reply(ev.id, { userAgent: 'fake' }); break;
    case 'model/list': reply(ev.id, { data: [{ id: p.cursor ? 'hidden' : 'first', model: p.cursor ? 'codex-hidden' : 'codex-test', displayName: p.cursor ? 'Hidden Codex' : 'Test Codex', supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'].map(reasoningEffort => ({ reasoningEffort })), hidden: !!p.cursor, isDefault: !p.cursor }], nextCursor: p.cursor ? null : 'second-page' }); break;
    case 'config/read': reply(ev.id, { config: { model: process.env.FAKE_CODEX_CONFIG_MODEL || null } }); break;
    case 'getAuthStatus': reply(ev.id, { authMethod: 'chatgpt', authToken: 'test-only-auth-token', requiresOpenaiAuth: true }); break;
    case 'account/read': reply(ev.id, { account: process.env.FAKE_CODEX_ACCOUNT_TYPE ? { type: process.env.FAKE_CODEX_ACCOUNT_TYPE } : null, requiresOpenaiAuth: true }); break;
    case 'skills/list':
      reply(ev.id, { data: [{ cwd: p.cwds[0], skills: [
        { name: 'test-skill', path: '/tmp/test-skill/SKILL.md', description: 'A test skill', enabled: true },
        { name: 'disabled-skill', path: '/tmp/disabled-skill/SKILL.md', description: 'Disabled', enabled: false },
      ], errors: [] }] }); break;
    case 'plugin/installed': reply(ev.id, { marketplaces: [{ name: 'test-marketplace', path: null, plugins: [
      { id: 'test-plugin@test-marketplace', name: 'test-plugin', installed: true, enabled: true },
      { id: 'disabled@test-marketplace', name: 'disabled', installed: true, enabled: false },
    ] }] }); break;
    case 'plugin/read': reply(ev.id, { plugin: { skills: [{ name: 'remote-skill', description: 'A remote skill', path: null, enabled: true }] } }); break;
    case 'thread/settings/update':
      if (process.env.FAKE_CODEX_REJECT_REVIEWER && process.env.FAKE_CODEX_REJECT_REVIEWER === p.approvalsReviewer) emit({ id: ev.id, error: { code: -32602, message: 'Automatic reviewer disallowed by organization.' } });
      else reply(ev.id, {});
      break;
    case 'thread/goal/get': reply(ev.id, { goal: goal || null }); break;
    case 'thread/goal/set':
      if (!p.objective && !goal) { emit({ id: ev.id, error: { code: -32602, message: 'No goal exists.' } }); break; }
      goal = { ...(goal || {}), threadId: p.threadId, objective: p.objective || goal?.objective, status: p.status || 'active', tokensUsed: 0, tokenBudget: null };
      reply(ev.id, { goal }); break;
    case 'thread/goal/clear': goal = null; reply(ev.id, {}); break;
    case 'thread/compact/start': reply(ev.id, {}); break;
    case 'mcpServerStatus/list': reply(ev.id, { data: [{ name: 'test-mcp', authStatus: 'notLoggedIn', tools: { search: {} } }], nextCursor: null }); break;
    case 'account/rateLimits/read': reply(ev.id, { rateLimits: { primary: { usedPercent: 23 } } }); break;
    case 'review/start':
      turnId = 'review-' + (++turn);
      reply(ev.id, { turn: { id: turnId, status: 'inProgress' } });
      notify('turn/started', { threadId, turn: { id: turnId } });
      setTimeout(() => finish('Review complete.'), 30);
      break;
    case 'thread/list': reply(ev.id, { data: [{ id: 'past-codex', cwd: p.cwd, preview: 'Earlier Codex conversation', updatedAt: 1700000000 }], nextCursor: null }); break;
    case 'thread/start': case 'thread/resume': case 'thread/fork':
      turn = ev.method === 'thread/start' ? 0 : readCount(p.threadId);
      threadId = ev.method === 'thread/resume' ? p.threadId : randomUUID();
      if (countPath(threadId)) fs.writeFileSync(countPath(threadId), String(turn));
      reply(ev.id, { thread: { id: threadId, turns: [] }, model: p.model || 'codex-test' });
      break;
    case 'turn/start': {
      turnId = 'turn-' + (++turn);
      if (countPath(threadId)) fs.writeFileSync(countPath(threadId), String(turn));
      reply(ev.id, { turn: { id: turnId } });
      notify('turn/started', { threadId, turn: { id: turnId } });
      if (process.env.FAKE_CODEX_REJECT_MODEL && p.model === process.env.FAKE_CODEX_REJECT_MODEL) {
        const message = `The '${p.model}' model is not supported when using Codex with a ChatGPT account.`;
        notify('error', { threadId, error: { message } });
        notify('turn/completed', { threadId, turn: { id: turnId, status: 'failed', error: { message } } });
        break;
      }
      const text = p.input.filter((b) => b.type === 'text').map((b) => b.text).join(' ');
      if (/permission|question|grant/.test(text)) {
        notify('item/started', { threadId, turnId, item: { type: 'commandExecution', id: 'cmd-' + turn, command: 'echo hi' } });
        pending = { id: 500 + turn };
        const method = /question/.test(text) ? 'item/tool/requestUserInput' : /grant/.test(text) ? 'item/permissions/requestApproval' : 'item/commandExecution/requestApproval';
        emit({ id: pending.id, method, params: { threadId, turnId, itemId: 'cmd-' + turn, command: 'echo hi', permissions: { network: { enabled: true } }, questions: [{ id: 'q1', question: 'Which option?', header: 'Choice', options: [{ label: 'A', description: 'First' }] }] } });
      } else if (/slow/.test(text)) {
        // The interrupt must end the turn before the next queued message starts.
      } else if (/agent/.test(text)) {
        const item = { type: 'collabAgentToolCall', id: 'spawn', tool: 'spawnAgent', receiverThreadIds: ['child'], prompt: 'look around', model: 'codex-test', agentsStates: { child: { status: 'running' } } };
        notify('item/started', { threadId, turnId, item });
        notify('item/completed', { threadId: 'child', turnId: 'child-turn', item: { type: 'agentMessage', id: 'child-text', text: 'found it' } });
        notify('item/completed', { threadId, turnId, item: { ...item, agentsStates: { child: { status: 'completed', message: 'done' } } } });
        finish('with agent');
      } else finish(text);
      break;
    }
    case 'turn/interrupt': reply(ev.id, {}); pending = null; notify('turn/completed', { threadId, turn: { id: turnId, status: 'interrupted' } }); break;
    case 'initialized': break;
    default: reply(ev.id, {});
  }
});
rl.on('close', () => process.exit(0));
function finish(text) {
  notify('item/agentMessage/delta', { threadId, turnId, itemId: 'text-' + turn, delta: text.slice(0, 3) });
  notify('item/agentMessage/delta', { threadId, turnId, itemId: 'text-' + turn, delta: text.slice(3) });
  notify('item/completed', { threadId, turnId, item: { type: 'agentMessage', id: 'text-' + turn, text } });
  notify('thread/tokenUsage/updated', { threadId, turnId, tokenUsage: { total: { inputTokens: 100 * turn, cachedInputTokens: 20 * turn, outputTokens: 10 * turn }, last: { inputTokens: 100, cachedInputTokens: 20, outputTokens: 10 }, modelContextWindow: 200000 } });
  notify('turn/completed', { threadId, turn: { id: turnId, status: 'completed' } });
}
