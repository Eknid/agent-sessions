import assert from 'node:assert/strict';
import { test } from 'node:test';
import { userMessage } from '../src/core/events';
import { MAIN } from '../src/core/sessionModel';
import { Item, Transcript } from '../src/core/transcript';
import { loadFixture } from './helpers';

function build(fixture: string, owner = MAIN): Item[] {
  const t = new Transcript({ owner });
  for (const rec of loadFixture(fixture)) t.apply(rec);
  return t.all();
}

const of = <K extends Item['kind']>(items: Item[], kind: K) => items.filter((i): i is Extract<Item, { kind: K }> => i.kind === kind);

test('main transcript: your message, Claude text, agent call, permission, turn end', () => {
  const items = build('03-forwarded-subagent-permission.ndjson');
  assert.match(of(items, 'user')[0].text, /^First spawn one foreground subagent/);
  assert.ok(of(items, 'text').some((t) => t.markdown.includes('spawn a foreground subagent')));
  const agent = of(items, 'tool').find((t) => t.name === 'Agent')!;
  assert.equal(agent.summary, 'Echo PONG');
  assert.equal(agent.agent?.ownerId, 'toolu_018n5UN46acreWmpfDjM2XnN');
  assert.equal(agent.status, 'done');
  const bash = of(items, 'tool').find((t) => t.name === 'Bash')!;
  assert.equal(bash.input, 'touch probe_perm.txt');
  assert.equal(bash.status, 'error', 'the aborted permission stream made the call fail');
  const perm = of(items, 'permission')[0];
  assert.equal(perm.summary, 'Bash(touch probe_perm.txt)');
  assert.equal(perm.outcome, 'cancelled');
  assert.ok(of(items, 'note').some((n) => n.divider && /^Turn complete/.test(n.text)));
  assert.equal(of(items, 'text').some((t) => t.markdown === 'PONG'), false, "the subagent's text stays in its own tab");
});

test('subagent transcript shows only that subagent', () => {
  const items = build('03-forwarded-subagent-permission.ndjson', 'toolu_018n5UN46acreWmpfDjM2XnN');
  assert.equal(of(items, 'user')[0].text, 'Reply with: PONG');
  assert.ok(of(items, 'text').some((t) => t.markdown === 'PONG'));
  assert.equal(of(items, 'tool').length, 0);
});

test('question is answered in place, init shown once', () => {
  const items = build('05-ask-user-question.ndjson');
  const q = of(items, 'question')[0];
  assert.equal(q.questions[0].question, 'Which color do you prefer?');
  assert.deepEqual(q.questions[0].options.map((o) => o.label), ['Red', 'Blue']);
  assert.deepEqual(q.answers, { 'Which color do you prefer?': 'Blue' });
  assert.equal(of(items, 'note').filter((n) => n.text.includes('Claude Code 2.1.287')).length, 1);
  assert.equal(of(items, 'tool').some((t) => t.name === 'AskUserQuestion'), false, 'the question is not also drawn as a tool call');
});

test('updates come back as changed items: a tool gets its output', () => {
  const t = new Transcript({ owner: MAIN });
  const call = { type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 'tu1', name: 'Edit', input: { file_path: 'a.ts', old_string: 'x', new_string: 'y' } }] } };
  const [tool] = t.apply({ t: 1, dir: 'in', ev: call });
  assert.equal(tool.kind === 'tool' && tool.inputKind, 'diff');
  assert.equal(tool.kind === 'tool' && tool.input, 'a.ts\n- x\n+ y');
  const res = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }] } };
  const [updated] = t.apply({ t: 2, dir: 'in', ev: res });
  assert.equal(updated.id, 'tu1');
  assert.equal(updated.kind === 'tool' && updated.output, 'ok');
  assert.equal(t.all().length, 1, 'updated in place, not appended');
});

test('a message with images keeps them, and its text', () => {
  const t = new Transcript({ owner: MAIN });
  const ev = userMessage('what is this?', [{ mediaType: 'image/png', data: 'AAAA' }]);
  assert.deepEqual(ev.message.content[0], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } });
  const [u] = t.apply({ t: 1, dir: 'out', ev });
  assert.equal(u.kind === 'user' && u.text, 'what is this?');
  assert.deepEqual(u.kind === 'user' && u.images, [{ mediaType: 'image/png', data: 'AAAA' }]);
  assert.equal(userMessage('plain').message.content, 'plain', 'no images: plain string content as before');
});
