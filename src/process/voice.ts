import { randomUUID } from 'crypto';
import { SpawnSpec } from './claudeProcess';
import { CodexRpc } from './codexRpc';

/** Mono signed 16-bit PCM from the native microphone helper. */
export function pcmWav(pcm: Buffer, sampleRate: number): Buffer {
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000 || pcm.length % 2) throw new Error('Invalid microphone audio.');
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

const chatGptDeviceId = randomUUID();

function chatGptHeaders(token: string, accountId?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'x-openai-web-frontend': 'codex_webview',
    'x-oai-mcp-form-version': '2',
    'x-openai-codex-window-type': 'extension',
    'oai-did': chatGptDeviceId,
    originator: 'Codex Browser',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
    'sec-ch-ua': '"Chromium";v="136", "Google Chrome";v="136", "Not=A?Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"macOS"',
  };
  if (accountId) headers['ChatGPT-Account-ID'] = accountId;
  return headers;
}

function wavDurationMs(wav: Buffer): number | undefined {
  if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') return;
  const bytesPerSecond = wav.readUInt32LE(28);
  const dataBytes = wav.readUInt32LE(40);
  if (!bytesPerSecond || dataBytes > wav.length - 44) return;
  return Math.round(dataBytes * 1000 / bytesPerSecond);
}

/** Reuse Codex login; credentials and audio never enter the transcript or webview. */
export async function transcribeAudio(wav: Buffer, spec: SpawnSpec, signal: AbortSignal, http = fetch): Promise<string> {
  const rpc = new CodexRpc();
  const abort = () => rpc.kill();
  signal.addEventListener('abort', abort, { once: true });
  try {
    if (signal.aborted) throw new Error('Dictation cancelled.');
    rpc.start(spec);
    const initialized = await rpc.initialize();
    let auth = await rpc.request('getAuthStatus', { includeToken: true, refreshToken: false }, 15_000);
    const request = async (token: string) => {
      let accountId: string | undefined;
      try {
        const claim = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())['https://api.openai.com/auth']?.chatgpt_account_id;
        if (typeof claim === 'string') accountId = claim;
      } catch { /* API keys have no JWT account claim. */ }
      const apiKey = auth.authMethod === 'apikey';
      const headers: Record<string, string> = apiKey
        ? { Authorization: `Bearer ${token}`, originator: 'codex_vscode', ...(initialized.userAgent ? { 'User-Agent': initialized.userAgent } : {}) }
        : chatGptHeaders(token, accountId);
      const body = new FormData();
      body.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'dictation.wav');
      if (apiKey) {
        body.append('model', 'gpt-4o-mini-transcribe');
      } else {
        body.append('dictation_session_id', randomUUID());
        body.append('attempt_id', randomUUID());
        const durationMs = wavDurationMs(wav);
        if (durationMs !== undefined) body.append('duration_ms', String(durationMs));
      }
      return http(apiKey ? 'https://api.openai.com/v1/audio/transcriptions' : 'https://chatgpt.com/backend-api/transcribe',
        { method: 'POST', headers, body, signal, redirect: 'error' });
    };
    if (!auth.authToken) throw new Error('Sign in to Codex to use voice dictation.');
    let response = await request(auth.authToken);
    if (response.status === 401) {
      await response.body?.cancel();
      auth = await rpc.request('getAuthStatus', { includeToken: true, refreshToken: true }, 15_000);
      if (!auth.authToken) throw new Error('Sign in to Codex again to use voice dictation.');
      response = await request(auth.authToken);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Voice transcription failed (${response.status}).${response.status === 429 ? ' Usage limit reached; try again later.' : response.status === 403 ? ' ChatGPT rejected the Codex session; sign out and back in, then retry.' : ''}`);
    }
    const result = await response.json() as { text?: unknown };
    if (typeof result.text !== 'string') throw new Error('No transcription returned.');
    return result.text.trim();
  } finally { signal.removeEventListener('abort', abort); rpc.kill(); }
}

type VoiceState = 'idle' | 'starting' | 'recording' | 'transcribing';
type Command = (name: string, id?: string) => PromiseLike<any>;
export class VoiceDictation {
  private id?: string;
  private abort?: AbortController;
  private timer?: NodeJS.Timeout;
  private state: VoiceState = 'idle';
  private disposed = false;

  constructor(private command: Command, private transcribe: (wav: Buffer, signal: AbortSignal) => Promise<string>,
    private notify: (state: VoiceState, text?: string, error?: string) => void) {}

  private update(state: VoiceState, text?: string, error?: string) {
    this.state = state;
    if (!this.disposed) this.notify(state, text, error);
  }

  async toggle(): Promise<void> {
    if (this.disposed) return;
    if (this.state === 'recording') { await this.command('_codex.microphone.stop', this.id); return; }
    if (this.state !== 'idle') return;
    const id = this.id = randomUUID();
    const abort = this.abort = new AbortController();
    this.update('starting');
    const chunks: Buffer[] = [];
    let bytes = 0;
    let transcript: string | undefined;
    let failure: string | undefined;
    try {
      let available;
      try { available = await this.command('_codex.microphone.available'); }
      catch { throw new Error('Voice dictation requires the Codex Audio extension in VS Code.'); }
      if (!available) throw new Error('The microphone is unavailable on this system.');
      if (abort.signal.aborted) return;
      const started = await this.command('_codex.microphone.start', id);
      if (started?.status !== 'started') throw new Error(started?.reason === 'busy' ? 'The microphone is already in use.' : 'Could not start the microphone. Check microphone permission for VS Code.');
      if (abort.signal.aborted) return;
      this.update('recording');
      this.timer = setTimeout(() => { void this.command('_codex.microphone.stop', id); }, 120_000);
      while (!abort.signal.aborted) {
        const result = await this.command('_codex.microphone.read', id);
        if (abort.signal.aborted) return;
        if (result?.status === 'stopped') break;
        if (result?.status !== 'audio') throw new Error('Microphone capture failed. Please try again.');
        const chunk = Buffer.from(result.pcm, 'base64');
        bytes += chunk.length;
        if (bytes > 16 * 1024 * 1024) throw new Error('Recording is too long.');
        chunks.push(chunk);
      }
      clearTimeout(this.timer);
      await this.command('_codex.microphone.cancel', id);
      if (abort.signal.aborted) return;
      if (bytes < started.sampleRate) throw new Error('Record at least half a second of speech.');
      this.update('transcribing');
      this.timer = setTimeout(() => abort.abort(), 60_000);
      const text = await this.transcribe(pcmWav(Buffer.concat(chunks, bytes), started.sampleRate), abort.signal);
      if (!abort.signal.aborted) { transcript = text; failure = text ? undefined : 'No speech detected.'; }
    } catch (error) {
      failure = abort.signal.aborted ? 'Voice transcription timed out.' : (error as Error).message;
    } finally {
      clearTimeout(this.timer);
      await Promise.resolve(this.command('_codex.microphone.cancel', id)).catch(() => undefined);
      if (this.id === id) { this.id = undefined; this.abort = undefined; }
      this.update('idle', transcript, failure);
    }
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.timer);
    this.abort?.abort();
    if (this.id) void Promise.resolve(this.command('_codex.microphone.cancel', this.id)).catch(() => undefined);
  }
}
