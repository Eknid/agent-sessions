// Wire shapes of the Claude Code stream-json protocol, as observed on CLI 2.1.287.
// Many fields are undocumented, so everything beyond `type` is treated as optional.

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface StreamEvent {
  type: string;
  subtype?: string;
  [key: string]: any;
}

/**
 * One line of a session's event log. `in` = emitted by claude on stdout,
 * `out` = written by us to claude's stdin, `meta` = process lifecycle noted by the manager.
 * The log is the single source of truth: state, metrics and the rendered transcript
 * are all derived by replaying it.
 */
export interface LogRecord {
  t: number;
  dir: 'in' | 'out' | 'meta';
  ev: StreamEvent;
}

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
}

export interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  id?: string;
  input?: any;
  tool_use_id?: string;
  content?: any;
  is_error?: boolean;
  thinking?: string;
}

/** Answer we give to a `can_use_tool` control request. */
export type PermissionDecision =
  | { behavior: 'allow'; updatedInput: any; updatedPermissions?: any[] }
  | { behavior: 'deny'; message: string; interrupt?: boolean };

export const AGENT_TOOL_NAMES = new Set(['Agent', 'Task']);
export const QUESTION_TOOL_NAME = 'AskUserQuestion';

export function contentBlocks(ev: StreamEvent): ContentBlock[] {
  const c = ev.message?.content;
  if (Array.isArray(c)) return c as ContentBlock[];
  if (typeof c === 'string') return [{ type: 'text', text: c }];
  return [];
}

export interface ImageAttachment {
  mediaType: string;
  /** base64, no data: prefix */
  data: string;
}

/** A user turn; with images, the content becomes blocks (images first, as the API recommends). */
export function userMessage(text: string, images: ImageAttachment[] = []): StreamEvent {
  if (!images.length) return { type: 'user', message: { role: 'user', content: text } };
  const content: unknown[] = images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mediaType, data: i.data } }));
  if (text.trim()) content.push({ type: 'text', text });
  return { type: 'user', message: { role: 'user', content } };
}

export function controlResponse(requestId: string, response: unknown): StreamEvent {
  return { type: 'control_response', response: { subtype: 'success', request_id: requestId, response } };
}

export function controlError(requestId: string, error: string): StreamEvent {
  return { type: 'control_response', response: { subtype: 'error', request_id: requestId, error } };
}

export function interruptRequest(requestId: string): StreamEvent {
  return { type: 'control_request', request_id: requestId, request: { subtype: 'interrupt' } };
}
