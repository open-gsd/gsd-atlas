import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { FakeClock, makeTempDir } from '../test-kit/index.ts';
import type { TempDir } from '../test-kit/index.ts';
import { createFlightRecorder } from './flight.ts';
import type { FlightEvent, FlightRecorder } from './flight.ts';

const BIG = { maxEvents: 2000, maxBytes: 5_242_880 };

const temps: TempDir[] = [];
afterEach(() => {
  for (const each of temps.splice(0)) each.cleanup();
});

function rig(caps: { readonly maxEvents: number; readonly maxBytes: number } = BIG): {
  readonly dir: string;
  readonly clock: FakeClock;
  readonly recorder: FlightRecorder;
} {
  const tmp = makeTempDir();
  temps.push(tmp);
  const dir = path.join(tmp.path, 'flight');
  const clock = new FakeClock(1_000);
  return { dir, clock, recorder: createFlightRecorder({ dir, clock, ...caps }) };
}

const answer = (id: string, extra: Partial<FlightEvent> = {}): Omit<FlightEvent, 't'> => ({ kind: 'answer', id, tool: 'code_find', ...extra });

describe('flight recorder: append and recent', () => {
  it('append and recent: the newest events come back, newest last', async () => {
    const { recorder, clock } = rig();
    recorder.append(answer('a_0000000000000001'));
    await clock.advance(5);
    recorder.append(answer('a_0000000000000002'));
    await clock.advance(5);
    recorder.append(answer('a_0000000000000003'));
    assert.deepEqual(
      recorder.recent(2).map((event) => event.id),
      ['a_0000000000000002', 'a_0000000000000003'],
    );
    assert.deepEqual(
      recorder.recent(100).map((event) => event.t),
      [1_000, 1_005, 1_010],
      'every event carries the time the injected clock gave it',
    );
    assert.deepEqual(recorder.recent(0), []);
  });

  it('last answer: the newest answer event, skipping session markers after it', () => {
    const { recorder } = rig();
    assert.equal(recorder.lastAnswer(), null);
    recorder.append({ kind: 'session', id: 's_0000000000000001' });
    assert.equal(recorder.lastAnswer(), null);
    recorder.append(answer('a_0000000000000001'));
    recorder.append(answer('a_0000000000000002'));
    recorder.append({ kind: 'session', id: 's_0000000000000002' });
    assert.equal(recorder.lastAnswer()?.id, 'a_0000000000000002');
  });

  it('session marker: the id of the newest session event, or null', () => {
    const { recorder } = rig();
    assert.equal(recorder.sessionId(), null);
    recorder.append({ kind: 'session', id: 's_00000000000000aa' });
    recorder.append(answer('a_0000000000000001'));
    assert.equal(recorder.sessionId(), 's_00000000000000aa');
    recorder.append({ kind: 'session', id: 's_00000000000000bb' });
    assert.equal(recorder.sessionId(), 's_00000000000000bb');
  });

  it('a second recorder over the same directory reads what the first appended (another process)', () => {
    const { recorder, dir, clock } = rig();
    recorder.append(answer('a_0000000000000001'));
    const other = createFlightRecorder({ dir, clock, ...BIG });
    assert.equal(other.lastAnswer()?.id, 'a_0000000000000001');
    other.append(answer('a_0000000000000002'));
    assert.deepEqual(
      recorder.recent(10).map((event) => event.id),
      ['a_0000000000000001', 'a_0000000000000002'],
    );
  });
});

describe('flight recorder: what an event holds', () => {
  it('args truncated: string values are cut at 200 code points without splitting a pair, other values are kept', () => {
    const { recorder } = rig();
    const long = 'x'.repeat(5000);
    const emoji = '\u{1F600}'.repeat(300);
    recorder.append(answer('a_0000000000000001', { args: { name: long, glyphs: emoji, limit: 5, exact: true, nothing: null, nested: { deep: long } } }));
    const stored = recorder.recent(1)[0] as FlightEvent;
    const args = stored.args as Record<string, unknown>;
    assert.equal((args['name'] as string).length, 200);
    assert.equal(Array.from(args['glyphs'] as string).length, 200, 'cut on a code point boundary');
    assert.doesNotMatch(args['glyphs'] as string, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/, 'no lone high surrogate');
    assert.equal(args['limit'], 5);
    assert.equal(args['exact'], true);
    assert.equal(args['nothing'], null);
    assert.equal(((args['nested'] as Record<string, unknown>)['deep'] as string).length, 200);
  });

  it('caps the handles at 20 and keeps only the known fields', () => {
    const { recorder } = rig();
    const handles = Array.from({ length: 50 }, (_, index) => `sym/${String(index)}`);
    recorder.append({
      ...answer('a_0000000000000001', { handles, degraded: ['stale'], count: 50, outcome: 'ok', ms: 'le50' }),
      untrusted_text: 'fn secretSymbolName {',
      data: { secret: 1 },
    } as unknown as Omit<FlightEvent, 't'>);
    const stored = recorder.recent(1)[0] as FlightEvent;
    assert.equal(stored.handles?.length, 20);
    assert.deepEqual(stored.handles?.slice(0, 2), ['sym/0', 'sym/1']);
    assert.deepEqual(stored.degraded, ['stale']);
    assert.equal(stored.count, 50);
    assert.equal(stored.outcome, 'ok');
    assert.equal(stored.ms, 'le50');
    assert.doesNotMatch(JSON.stringify(stored), /secretSymbolName|secret/);
  });

  it('writes one JSON object per line, beside a segment file, with nothing else in the directory', () => {
    const { recorder, dir } = rig();
    recorder.append(answer('a_0000000000000001'));
    recorder.append(answer('a_0000000000000002'));
    assert.deepEqual(fs.readdirSync(dir), ['flight.jsonl']);
    const lines = fs.readFileSync(path.join(dir, 'flight.jsonl'), 'utf8').split('\n');
    assert.equal(lines.length, 3);
    assert.equal(lines[2], '');
    for (const line of lines.slice(0, 2)) assert.doesNotThrow(() => JSON.parse(line));
  });
});

describe('flight recorder: damage and failure', () => {
  it('corrupt line skipped: readers ignore a torn line, a foreign object and a blank line', () => {
    const { recorder, dir } = rig();
    recorder.append(answer('a_0000000000000001'));
    fs.appendFileSync(path.join(dir, 'flight.jsonl'), '{"t":1,"kind":"answer","id":"a_00\n\n[1,2]\n{"t":"x","kind":"answer","id":"a_1"}\nnot json at all\n{"t":5,"kind":"other","id":"a_2"}\n');
    recorder.append(answer('a_0000000000000002'));
    assert.deepEqual(
      recorder.recent(10).map((event) => event.id),
      ['a_0000000000000001', 'a_0000000000000002'],
    );
  });

  it('unwritable directory: append never throws, nothing is stored and every read is empty', () => {
    const tmp = makeTempDir();
    temps.push(tmp);
    const blocked = path.join(tmp.path, 'flight');
    fs.writeFileSync(blocked, 'a file where the directory belongs');
    const recorder = createFlightRecorder({ dir: blocked, clock: new FakeClock(1), ...BIG });
    assert.doesNotThrow(() => {
      recorder.append(answer('a_0000000000000001'));
    });
    assert.deepEqual(recorder.recent(5), []);
    assert.equal(recorder.lastAnswer(), null);
    assert.equal(recorder.sessionId(), null);
    assert.doesNotThrow(() => {
      recorder.close();
    });
  });

  it('a filesystem that throws on every call is survived', () => {
    const boom = (): never => {
      throw new Error('disk on fire');
    };
    const tmp = makeTempDir();
    temps.push(tmp);
    const recorder = createFlightRecorder({
      dir: path.join(tmp.path, 'flight'),
      clock: new FakeClock(1),
      ...BIG,
      fs: { mkdirSync: boom, appendFileSync: boom, readFileSync: boom, renameSync: boom, rmSync: boom, statSync: boom },
    });
    assert.doesNotThrow(() => {
      recorder.append(answer('a_0000000000000001'));
    });
    assert.deepEqual(recorder.recent(3), []);
  });
});
