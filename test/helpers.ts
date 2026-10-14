import * as fs from 'fs';
import * as path from 'path';
import { LogRecord } from '../src/core/events';
import { PriceTable } from '../src/core/pricing';
import { SessionModel, UiState } from '../src/core/sessionModel';

export const FIXTURES = path.join(__dirname, '..', '..', 'test', 'fixtures');

export function loadFixture(name: string): LogRecord[] {
  return fs
    .readFileSync(path.join(FIXTURES, name), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

export function newModel(): SessionModel {
  return new SessionModel({ id: 's1', name: 'test', cwd: '/tmp', createdAt: 0 }, new PriceTable());
}

/** Replays records and returns the model plus the sequence of distinct UI states seen. */
export function replay(records: LogRecord[], until?: (r: LogRecord, i: number) => boolean) {
  const m = newModel();
  const states: UiState[] = [];
  for (let i = 0; i < records.length; i++) {
    if (until?.(records[i], i)) break;
    m.apply(records[i]);
    const ui = m.uiState();
    if (states[states.length - 1] !== ui) states.push(ui);
  }
  return { model: m, states };
}
