import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as path from 'node:path';
import { pcmWav, transcribeAudio, VoiceDictation } from '../src/process/voice';

async function until(predicate: () => boolean) {
  for (let i = 0; !predicate(); i++) { if (i > 100) throw new Error('Timeout'); await new Promise((r) => setTimeout(r, 5)); }
}

test('Native dictation drains audio, stops capture and transcribes only after an explicit stop', async () => {
  let stopped = false;
  let sentAudio = false;
  let sentTranscription = false;
  let pending: ((result: any) => void) | undefined;
  const events: { state: string; text?: string; error?: string }[] = [];
  const commands: string[] = [];
  const voice = new VoiceDictation(async (name) => {
    commands.push(name);
    if (name.endsWith('available')) return 1;
    if (name.endsWith('start')) return { status: 'started', sampleRate: 16000 };
    if (name.endsWith('stop')) { stopped = true; pending?.({ status: 'stopped' }); return; }
    if (name.endsWith('read')) {
      if (!sentAudio) { sentAudio = true; return { status: 'audio', pcm: Buffer.alloc(32000).toString('base64') }; }
      if (stopped) return { status: 'stopped' };
      return new Promise((resolve) => { pending = resolve; });
    }
    return undefined;
  }, async (wav) => { sentTranscription = true; assert.equal(wav.readUInt32LE(40), 32000); return 'Prova vocale.'; },
  (state, text, error) => events.push({ state, text, error }));
  const running = voice.toggle();
  await until(() => !!pending);
  assert.equal(sentTranscription, false);
  await voice.toggle();
  await running;
  assert.equal(events.at(-1)?.text, 'Prova vocale.');
  assert.ok(commands.indexOf('_codex.microphone.stop') < commands.indexOf('_codex.microphone.cancel'));
  assert.ok(events.some((e) => e.state === 'transcribing'));
  voice.dispose();
});

test('Closing a tab cancels microphone capture and never submits audio', async () => {
  let pending: ((result: any) => void) | undefined;
  let submitted = false;
  const voice = new VoiceDictation(async (name) => {
    if (name.endsWith('available')) return 1;
    if (name.endsWith('start')) return { status: 'started', sampleRate: 16000 };
    if (name.endsWith('read')) return new Promise((resolve) => { pending = resolve; });
    if (name.endsWith('cancel')) pending?.({ status: 'stopped' });
    return undefined;
  }, async () => { submitted = true; return ''; }, () => undefined);
  const running = voice.toggle();
  await until(() => !!pending);
  voice.dispose(); await running;
  assert.equal(submitted, false);
});

test('Transcription uses authenticated multipart audio and reports HTTP errors without leaking credentials', async () => {
  const spec = { command: path.join(__dirname, '../../test/fake-codex.js'), args: ['app-server'], cwd: process.cwd() };
  const wav = pcmWav(Buffer.alloc(32000), 16000);
  const http: typeof fetch = async (url, options) => {
    assert.equal(url, 'https://chatgpt.com/backend-api/transcribe');
    assert.equal(options?.redirect, 'error');
    const headers = options?.headers as Record<string, string>;
    assert.ok(headers.Authorization);
    assert.equal(headers.originator, 'Codex Browser');
    assert.equal(headers['x-openai-web-frontend'], 'codex_webview');
    assert.equal(headers['x-openai-codex-window-type'], 'extension');
    assert.match(headers['oai-did'], /^[0-9a-f-]{36}$/);
    assert.match(headers['User-Agent'], /Chrome\/136/);
    assert.equal(headers['sec-ch-ua-platform'], '"macOS"');
    const form = options?.body as FormData;
    const file = form.get('file') as Blob;
    assert.equal(file.type, 'audio/wav'); assert.equal(file.size, wav.length);
    assert.match(String(form.get('dictation_session_id')), /^[0-9a-f-]{36}$/);
    assert.match(String(form.get('attempt_id')), /^[0-9a-f-]{36}$/);
    assert.equal(form.get('duration_ms'), '1000');
    return new Response(JSON.stringify({ text: ' Frase italiana. ' }), { status: 200 });
  };
  assert.equal(await transcribeAudio(wav, spec, AbortSignal.timeout(5000), http), 'Frase italiana.');
  await assert.rejects(transcribeAudio(wav, spec, AbortSignal.timeout(5000), async () => new Response('secret detail', { status: 403 })),
    (error: Error) => /403/.test(error.message) && !/secret|test-only-auth/.test(error.message));
});
