import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { allowAll, createRealRunner } from '../command-runner/index.ts';
import { FakeClock, makeTempDir } from '../test-kit/index.ts';
import type { TempDir } from '../test-kit/index.ts';
import { createFlightRecorder } from './flight.ts';
import type { FlightEvent, FlightFs, FlightRecorder } from './flight.ts';

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

const CURRENT = 'flight.jsonl';
const PREVIOUS = 'flight.prev.jsonl';

/** The id of the n-th event, fixed width so every line has the same length. */
const idOf = (tag: string, n: number): string => `${tag}-${String(n).padStart(4, '0')}`;

/** Every non-empty line of both segments, parsed; a line that does not parse fails the test (a torn line is a bug). */
function wholeLines(dir: string): FlightEvent[] {
  const out: FlightEvent[] = [];
  for (const name of [PREVIOUS, CURRENT]) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(text === '' || text.endsWith('\n'), `${name} ends with a newline`);
    for (const line of text.split('\n')) {
      if (line === '') continue;
      out.push(JSON.parse(line) as FlightEvent);
    }
  }
  return out;
}

const bytesOnDisk = (dir: string): number =>
  fs.readdirSync(dir).reduce((sum, name) => sum + fs.statSync(path.join(dir, name)).size, 0);

describe('flight recorder: caps and rotation', () => {
  /** The ids `recorder` reads: at most `cap` of them, and always the newest `kept` events with no gap, ending at event `last`. */
  const assertNewestSuffix = (recorder: FlightRecorder, tag: string, last: number, cap: number): void => {
    const kept = recorder.recent(1000).map((event) => event.id);
    assert.ok(kept.length <= cap, `at most ${String(cap)} events are readable, got ${String(kept.length)}`);
    assert.ok(kept.length >= cap / 2, `at least half the cap survives a rotation, got ${String(kept.length)}`);
    assert.deepEqual(
      kept,
      Array.from({ length: kept.length }, (_, index) => idOf(tag, last - kept.length + 1 + index)),
      'the survivors are the newest events, in order, with no gap',
    );
  };

  it('event cap: 25 events leave at most 10, the newest ones in order, and never more than two segment files', async () => {
    const { recorder, dir, clock } = rig({ maxEvents: 10, maxBytes: 100_000 });
    for (let n = 1; n <= 25; n += 1) {
      recorder.append(answer(idOf('e', n)));
      await clock.advance(1);
      assert.ok(fs.readdirSync(dir).length <= 2, `after event ${String(n)}: ${fs.readdirSync(dir).join(', ')}`);
    }
    assertNewestSuffix(recorder, 'e', 25, 10);
    assert.deepEqual(fs.readdirSync(dir).sort(), [PREVIOUS, CURRENT].sort());
    assert.equal(clock.pending(), 0, 'no timer was armed: appending is one write and at most one rename');
    for (let n = 26; n <= 60; n += 1) {
      recorder.append(answer(idOf('e', n)));
      assertNewestSuffix(recorder, 'e', n, 10);
    }
    assert.equal(recorder.lastAnswer()?.id, idOf('e', 60));
    assert.ok(fs.readdirSync(dir).length <= 2);
  });

  it('byte cap: with 100-byte events and a 2000-byte cap the disk stays within twice the cap and the newest events survive', () => {
    const { recorder, dir } = rig({ maxEvents: 2000, maxBytes: 2000 });
    const pad = 'x'.repeat(40);
    let lineBytes = 0;
    for (let n = 1; n <= 100; n += 1) {
      recorder.append(answer(idOf('b', n), { args: { pad } }));
      const size = fs.readdirSync(dir).reduce((sum, name) => sum + fs.statSync(path.join(dir, name)).size, 0);
      assert.ok(size <= 4000, `after event ${String(n)}: ${String(size)} bytes`);
      if (n === 1) lineBytes = fs.statSync(path.join(dir, CURRENT)).size;
    }
    assert.ok(lineBytes >= 80 && lineBytes <= 160, `an event is about 100 bytes, got ${String(lineBytes)}`);
    assert.ok(bytesOnDisk(dir) <= 4000);
    const kept = recorder.recent(1000).map((event) => event.id);
    assert.ok(kept.length >= 10 && kept.length < 100, `kept ${String(kept.length)} of 100`);
    assert.equal(kept[kept.length - 1], idOf('b', 100));
    assert.deepEqual(
      kept,
      Array.from({ length: kept.length }, (_, index) => idOf('b', 100 - kept.length + 1 + index)),
      'the survivors are the newest events, with no gap',
    );
  });

  it('a recorder opened on a full segment rotates it on its next append instead of growing it', () => {
    const first = rig({ maxEvents: 10, maxBytes: 100_000 });
    for (let n = 1; n <= 5; n += 1) first.recorder.append(answer(idOf('o', n)));
    const second = createFlightRecorder({ dir: first.dir, clock: first.clock, maxEvents: 10, maxBytes: 100_000 });
    second.append(answer(idOf('o', 6)));
    second.append(answer(idOf('o', 7)));
    assert.ok(fs.existsSync(path.join(first.dir, PREVIOUS)), 'the 6th event pushed the segment past half the cap');
    assert.deepEqual(
      second.recent(100).map((event) => event.id),
      Array.from({ length: 7 }, (_, index) => idOf('o', 1 + index)),
    );
  });

  it('a segment that cannot be renamed costs nothing but the rotation: appends keep working and nothing throws', () => {
    const real = rig({ maxEvents: 10, maxBytes: 100_000 });
    const failing: FlightFs = {
      mkdirSync: (dir, options) => fs.mkdirSync(dir, options),
      appendFileSync: (file, data, options) => {
        fs.appendFileSync(file, data, options);
      },
      readFileSync: (file, encoding) => fs.readFileSync(file, encoding),
      renameSync: () => {
        throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      },
      rmSync: (target, options) => {
        fs.rmSync(target, options);
      },
      statSync: (file) => fs.statSync(file),
    };
    const recorder = createFlightRecorder({ dir: real.dir, clock: real.clock, maxEvents: 10, maxBytes: 100_000, fs: failing });
    for (let n = 1; n <= 20; n += 1) assert.doesNotThrow(() => { recorder.append(answer(idOf('r', n))); });
    assert.equal(recorder.recent(100).length, 10, 'readers still trim to the cap');
    assert.equal(recorder.lastAnswer()?.id, idOf('r', 20));
  });
});

describe('flight recorder: concurrent writers', () => {
  it('concurrent instances: two recorders on one folder, 200 appends each with awaits between, leave only whole lines and the newest events', async () => {
    const { dir, clock } = rig();
    const caps = { maxEvents: 50, maxBytes: 100_000 };
    const a = createFlightRecorder({ dir, clock, ...caps });
    const b = createFlightRecorder({ dir, clock, ...caps });
    const run = async (recorder: FlightRecorder, tag: string): Promise<void> => {
      for (let n = 0; n < 200; n += 1) {
        recorder.append(answer(idOf(tag, n)));
        await clock.advance(1);
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
      }
    };
    await Promise.all([run(a, 'a'), run(b, 'b')]);
    const lines = wholeLines(dir);
    assert.ok(lines.length >= 25 && lines.length <= 60, `${String(lines.length)} lines on disk`);
    assert.ok(fs.readdirSync(dir).length <= 2);
    const read = a.recent(1000).map((event) => event.id);
    assert.ok(read.length <= 50, `at most the cap is readable, got ${String(read.length)}`);
    assert.ok(read.includes(idOf('a', 199)), 'the newest event of the first instance is present');
    assert.ok(read.includes(idOf('b', 199)), 'the newest event of the second instance is present');
    assert.deepEqual(read, b.recent(1000).map((event) => event.id), 'both instances read the same thing');
  });

  it('two processes: child processes appending at once leave only complete lines, and every event with room to keep it', async () => {
    const tmp = makeTempDir();
    temps.push(tmp);
    const dir = path.join(tmp.path, 'flight');
    const script = path.join(tmp.path, 'append.mjs');
    fs.writeFileSync(
      script,
      [
        `import { createFlightRecorder } from ${JSON.stringify(pathToFileURL(path.resolve(import.meta.dirname, 'flight.ts')).href)};`,
        'const [dir, tag, count, maxEvents, maxBytes] = process.argv.slice(2);',
        'const clock = { now: () => Date.now(), sleep: () => Promise.resolve(), after: () => () => {} };',
        'const recorder = createFlightRecorder({ dir, clock, maxEvents: Number(maxEvents), maxBytes: Number(maxBytes) });',
        'for (let n = 0; n < Number(count); n += 1) {',
        "  recorder.append({ kind: 'answer', id: `${tag}-${String(n).padStart(4, '0')}`, tool: 'code_find', args: { name: 'x'.repeat(120) } });",
        '}',
      ].join('\n'),
    );
    const runner = createRealRunner({ decide: allowAll });
    const spawn = (tag: string, count: number, maxEvents: number, maxBytes: number) =>
      runner.run({ executable: process.execPath, args: [script, dir, tag, String(count), String(maxEvents), String(maxBytes)] });

    // Caps far above the load: nothing may be lost, and no line may be torn.
    const roomy = await Promise.all([spawn('p', 100, 2000, 5_242_880), spawn('q', 100, 2000, 5_242_880)]);
    for (const result of roomy) assert.equal(result.ok, true, `${result.stderr}`);
    const all = wholeLines(dir);
    assert.equal(all.length, 200);
    assert.equal(new Set(all.map((event) => event.id)).size, 200, 'every event is there exactly once');

    // Caps that force rotations while both write: every line that is left is whole, and the cap holds.
    fs.rmSync(dir, { recursive: true, force: true });
    const tight = await Promise.all([spawn('p', 100, 20, 100_000), spawn('q', 100, 20, 100_000)]);
    for (const result of tight) assert.equal(result.ok, true, `${result.stderr}`);
    const reader = createFlightRecorder({ dir, clock: new FakeClock(1), maxEvents: 20, maxBytes: 100_000 });
    assert.ok(wholeLines(dir).length > 0);
    assert.ok(fs.readdirSync(dir).length <= 2);
    assert.ok(reader.recent(1000).length <= 20);
    assert.ok(reader.lastAnswer() !== null);
  });
});

describe('flight recorder: readers, clear and modes', () => {
  it('reader during rotation: a missing segment is empty, and a rotation between the two reads is seen whole', () => {
    const { recorder, dir, clock } = rig({ maxEvents: 10, maxBytes: 100_000 });
    assert.deepEqual(recorder.recent(5), [], 'no segment at all');
    for (let n = 1; n <= 6; n += 1) recorder.append(answer(idOf('d', n)));
    assert.ok(fs.existsSync(path.join(dir, PREVIOUS)));
    assert.equal(fs.existsSync(path.join(dir, CURRENT)), false, 'right after a rotation the current segment does not exist yet');
    assert.equal(recorder.recent(100).length, 6, 'a missing current segment reads as empty');

    // A rotation that happens while a reader is between its two reads (after the previous segment, before the current
    // one): the reader must see the segment that moved, not the one it read just before.
    const live = createFlightRecorder({ dir, clock, maxEvents: 10, maxBytes: 100_000 });
    for (let n = 7; n <= 9; n += 1) live.append(answer(idOf('d', n)));
    let rotated = false;
    const racing: FlightFs = {
      mkdirSync: (target, options) => fs.mkdirSync(target, options),
      appendFileSync: (file, data, options) => {
        fs.appendFileSync(file, data, options);
      },
      readFileSync: (file, encoding) => {
        if (!rotated && file.endsWith(CURRENT)) {
          rotated = true;
          fs.renameSync(path.join(dir, CURRENT), path.join(dir, PREVIOUS));
        }
        return fs.readFileSync(file, encoding);
      },
      renameSync: (from, to) => {
        fs.renameSync(from, to);
      },
      rmSync: (target, options) => {
        fs.rmSync(target, options);
      },
      statSync: (file) => fs.statSync(file),
    };
    const reader = createFlightRecorder({ dir, clock, maxEvents: 100, maxBytes: 100_000, fs: racing });
    let seen: string[] = [];
    assert.doesNotThrow(() => {
      seen = reader.recent(100).map((event) => event.id);
    });
    assert.ok(rotated, 'the rotation happened during the read');
    assert.deepEqual(seen, [idOf('d', 7), idOf('d', 8), idOf('d', 9)], 'the moved segment is read again, so its newest events are not missed');
  });

  it('clear: removes both segments, reads are empty afterwards, clearing an empty folder is harmless, and appending works again', () => {
    const { recorder, dir } = rig({ maxEvents: 10, maxBytes: 100_000 });
    assert.doesNotThrow(() => {
      recorder.clear();
    });
    for (let n = 1; n <= 8; n += 1) recorder.append(answer(idOf('c', n)));
    assert.ok(fs.existsSync(path.join(dir, PREVIOUS)) && fs.existsSync(path.join(dir, CURRENT)));
    recorder.clear();
    assert.equal(fs.existsSync(path.join(dir, PREVIOUS)), false);
    assert.equal(fs.existsSync(path.join(dir, CURRENT)), false);
    assert.deepEqual(recorder.recent(5), []);
    assert.equal(recorder.lastAnswer(), null);
    recorder.append(answer(idOf('c', 9)));
    assert.deepEqual(
      recorder.recent(5).map((event) => event.id),
      [idOf('c', 9)],
    );
  });

  it('clear by one instance is seen by another on the same folder', () => {
    const { recorder, dir, clock } = rig();
    const other = createFlightRecorder({ dir, clock, ...BIG });
    recorder.append(answer(idOf('x', 1)));
    other.clear();
    assert.deepEqual(recorder.recent(5), []);
  });

  it('file modes: the folder is 0700 and every segment 0600 (POSIX)', { skip: process.platform === 'win32' }, () => {
    const { recorder, dir } = rig({ maxEvents: 10, maxBytes: 100_000 });
    for (let n = 1; n <= 8; n += 1) recorder.append(answer(idOf('m', n)));
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    for (const name of [PREVIOUS, CURRENT]) {
      assert.equal(fs.statSync(path.join(dir, name)).mode & 0o777, 0o600, name);
    }
  });
});
