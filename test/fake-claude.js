#!/usr/bin/env node
// Minimal stand-in for `claude -p --input-format stream-json --output-format stream-json`,
// speaking the same wire protocol observed on CLI 2.1.287. Used by the manager tests.
'use strict';
const fs = require('fs');
const readline = require('readline');

const argsFile = process.env.FAKE_CLAUDE_ARGS_FILE;
if (argsFile) fs.appendFileSync(argsFile, JSON.stringify(process.argv.slice(2)) + '\n');

const sid = (() => {
  const a = process.argv;
  const i = a.indexOf('--session-id') >= 0 ? a.indexOf('--session-id') : a.indexOf('--resume');
  return i >= 0 ? a[i + 1] : 'none';
})();

let cost = Number(process.env.FAKE_CLAUDE_BASE_COST || 0);
// Like the real CLI, a fork's total includes its parent's cost (the tests' parents spend one turn).
if (process.argv.includes('--fork-session')) cost += 0.01;
let msg = 0;
const emit = (o) => process.stdout.write(JSON.stringify({ session_id: sid, ...o }) + '\n');
const usage = { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000 };
const assistant = (content, parent = null) =>
  emit({ type: 'assistant', parent_tool_use_id: parent, message: { id: `msg_${++msg}`, model: 'claude-sonnet-5-5', usage, content } });

// Like the real CLI, init only arrives once the first message is on stdin.
let permissionMode = process.argv[process.argv.indexOf('--permission-mode') + 1] || 'default';
if (!process.argv.includes('--permission-mode')) permissionMode = 'default';
let initSent = false;
const init = () => {
  if (initSent) return;
  initSent = true;
  emit({ type: 'system', subtype: 'init', permissionMode, model: 'claude-sonnet-5-5', cwd: process.cwd(), claude_code_version: 'fake',
    slash_commands: ['compact', 'context', 'doctor'], terminal_slash_commands: ['doctor'] });
};

let waiting = null;
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const ev = JSON.parse(line);
  if (process.env.FAKE_CLAUDE_LOG) fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, line + '\n');
  if (ev.type === 'user') {
    init();
    const c = ev.message.content;
    const text = typeof c === 'string' ? c : c.map((b) => (b.type === 'text' ? b.text : `[${b.type}]`)).join(' ');
    if (/permission/.test(text)) {
      assistant([{ type: 'tool_use', id: 'tu_bash', name: 'Bash', input: { command: 'echo hi' } }]);
      waiting = 'perm_1';
      emit({ type: 'control_request', request_id: waiting, request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'echo hi' }, tool_use_id: 'tu_bash', permission_suggestions: [{ type: 'addRules' }] } });
    } else if (/agent/.test(text)) {
      assistant([{ type: 'tool_use', id: 'tu_agent', name: 'Agent', input: { description: 'look around', subagent_type: 'Explore', model: 'haiku' } }]);
      emit({ type: 'system', subtype: 'task_started', task_id: 'ag1', tool_use_id: 'tu_agent', subagent_type: 'Explore', description: 'look around', task_type: 'local_agent', is_backgrounded: false });
      emit({ type: 'assistant', parent_tool_use_id: 'tu_agent', message: { id: `msg_${++msg}`, model: 'claude-haiku-4-5-20251001', usage, content: [{ type: 'text', text: 'found it' }] } });
      emit({ type: 'system', subtype: 'task_notification', task_id: 'ag1', tool_use_id: 'tu_agent', status: 'completed', summary: 'found it' });
      emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_agent', content: 'found it' }] }, tool_use_result: { status: 'completed', agentId: 'ag1', totalTokens: 1130 } });
      finish('done with agent');
    } else {
      finish('echo: ' + text);
    }
  } else if (ev.type === 'control_response' && ev.response.request_id === waiting) {
    waiting = null;
    const ok = ev.response.response.behavior === 'allow';
    emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_bash', content: ok ? 'hi' : 'denied', is_error: !ok }] } });
    finish(ok ? 'ran it' : 'not allowed');
  } else if (ev.type === 'control_request' && ev.request.subtype === 'set_permission_mode') {
    if (process.env.FAKE_CLAUDE_REJECT_PERMISSION === ev.request.mode) {
      emit({ type: 'control_response', response: { subtype: 'error', request_id: ev.request_id, error: 'Permission mode disallowed by organization.' } });
    } else {
      permissionMode = ev.request.mode;
      emit({ type: 'control_response', response: { subtype: 'success', request_id: ev.request_id, response: { mode: permissionMode } } });
    }
  } else if (ev.type === 'control_request' && ev.request.subtype === 'get_usage') {
    emit({ type: 'control_response', response: { subtype: 'success', request_id: ev.request_id, response: {
      subscription_type: 'enterprise', rate_limits: { spend: { used: { amount_minor: 44668, currency: 'USD', exponent: 2 }, limit: { amount_minor: 100000, currency: 'USD', exponent: 2 }, percent: 45 } }
    } } });
  } else if (ev.type === 'control_request' && ev.request.subtype === 'apply_flag_settings') {
    emit({ type: 'control_response', response: { subtype: 'success', request_id: ev.request_id, response: {} } });
  } else if (ev.type === 'control_request' && ev.request.subtype === 'initialize') {
    emit({ type: 'control_response', response: { subtype: 'success', request_id: ev.request_id, response: { models: [
      { value: 'default', resolvedModel: 'claude-sonnet-5-5', displayName: 'Default' },
      { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
      { value: 'claude-opus-4-8', resolvedModel: 'claude-opus-4-8', displayName: 'Opus 4.8' },
      { value: 'claude-opus-4-1-20250805', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 4.1' },
    ] } } });
  } else if (ev.type === 'control_request' && ev.request.subtype === 'interrupt') {
    emit({ type: 'control_response', response: { subtype: 'success', request_id: ev.request_id, response: {} } });
  }
});
rl.on('close', () => process.exit(0));

function finish(text) {
  assistant([{ type: 'text', text }]);
  cost += 0.01;
  emit({ type: 'result', subtype: 'success', is_error: false, result: text, total_cost_usd: cost, num_turns: 1, duration_ms: 5,
    modelUsage: { 'claude-sonnet-5-5': { contextWindow: 1000000, costUSD: cost } } });
}
