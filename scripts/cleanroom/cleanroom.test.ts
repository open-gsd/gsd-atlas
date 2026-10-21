/**
 * Cases for the clean-room replication tooling (plan 03-39, tasks 1 and 2). Every fixture is built in a
 * temporary directory; nothing here needs a network, Docker or ssh.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, test } from 'node:test';

import { readPrereg } from '../eval/prereg.ts';
import { ResultRowSchema } from '../eval/rows.ts';
import type { ResultRow } from '../eval/rows.ts';
import { ATLAS_TOOL_NAMES } from '../eval/arms.ts';
import { checkResultsDir, discardAfter, ORIGINAL_MEAN_WALL_MS } from './check-chunk.ts';
import type { CheckResult } from './check-chunk.ts';
import { AGREEMENT_RULES, DECLARED_DIFFERENCES, compareRuns, renderComparison } from './compare.ts';
import { EXPECTED_INIT, diffSignature, signatureOf } from './init-signature.ts';
import { findLeaks, scrubText } from './scrub.ts';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const PREREG_FILE = path.join(REPO, 'docs', 'eval', 'preregistration.md');
const ORIGINAL_FILE = path.join(REPO, 'docs', 'eval', 'results', 'results.jsonl');
const HAVE_ORIGINAL = fs.existsSync(ORIGINAL_FILE);
const OK_FIXTURE = path.join(REPO, 'scripts', 'eval', '__fixtures__', 'claude-stream-ok.jsonl');
const SCRIPT = (name: string): string => path.join(REPO, 'scripts', 'cleanroom', name);

const scratch: string[] = [];
function tmpDir(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cleanroom-${label}-`));
  scratch.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function runScript(name: string, args: string[], env: Record<string, string> = {}): { code: number | null; stdout: string; stderr: string } {
  const done = spawnSync(process.execPath, [SCRIPT(name), ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
  return { code: done.status, stdout: done.stdout, stderr: done.stderr };
}

// ---------------------------------------------------------------------------------------------
// Fixture builders

type ArmId = 'atlas' | 'grep';
interface Cell {
  questionId: string;
  arm: ArmId;
  run: number;
}
const DEFAULT_CELLS: Cell[] = [
  { questionId: 'q-001', arm: 'atlas', run: 1 },
  { questionId: 'q-001', arm: 'grep', run: 1 },
  { questionId: 'q-002', arm: 'atlas', run: 1 },
  { questionId: 'q-002', arm: 'grep', run: 1 },
];
const cellKey = (cell: Cell): string => `${cell.questionId}|${cell.arm}|${String(cell.run)}`;
const streamName = (cell: Cell, attempt = 1): string => `${cell.questionId}.${cell.arm}.${String(cell.run)}.a${String(attempt)}.jsonl`;

function makeRow(cell: Cell, over: Partial<ResultRow> = {}): ResultRow {
  return {
    questionId: cell.questionId,
    category: 'callers',
    arm: cell.arm,
    run: cell.run,
    status: 'ok',
    answered: 'found',
    correct: true,
    citation: { applicable: true, total: 1, verified: 1, hasVerifiable: true },
    usage: { input: 10, output: 20, cacheCreation: 30, cacheRead: 40 },
    billableTokens: 100,
    toolCalls: 1,
    toolCallsByName: { Read: 1 },
    atlasToolCalls: 0,
    wallMs: 8000,
    costUsd: 0.02,
    ...over,
  };
}

type Json = Record<string, unknown>;

function initEvent(arm: ArmId): Json {
  const expected = EXPECTED_INIT[arm];
  return {
    type: 'system',
    subtype: 'init',
    cwd: '/work/session',
    session_id: 'SESSION-1',
    tools: [...expected.tools],
    mcp_servers: expected.mcpServers.map((server) => ({ name: server.name, status: server.status })),
    model: expected.model,
    permissionMode: expected.permissionMode,
    apiKeySource: expected.apiKeySource,
    claude_code_version: expected.claudeCodeVersion,
    agents: [...expected.agents],
    skills: [...expected.skills],
    plugins: expected.plugins.map((name) => ({ name, path: 'builtin', source: `${name}@builtin` })),
  };
}

interface RateOptions {
  status?: string;
  fiveHour?: number;
  sevenDay?: number;
  isUsingOverage?: boolean;
  overageEnabled?: boolean;
}
function rateEvent(options: RateOptions = {}): Json {
  const info: Json = {
    status: options.status ?? 'allowed_warning',
    resetsAt: 1792299000,
    rateLimitType: 'five_hour',
    overageStatus: 'rejected',
    overageDisabledReason: 'org_level_disabled',
    isUsingOverage: options.isUsingOverage ?? false,
    unifiedWindows: {
      five_hour: { utilization: options.fiveHour ?? 0.28, resetsAt: 1792299000 },
      seven_day: { utilization: options.sevenDay ?? 0.56, resetsAt: 1792537200 },
    },
  };
  if (options.overageEnabled !== undefined) info['overageEnabled'] = options.overageEnabled;
  return { type: 'rate_limit_event', rate_limit_info: info, uuid: 'UUID-R', session_id: 'SESSION-1' };
}

const ANSWER_TEXT = 'SECRET-ANSWER-TEXT-do-not-echo';

function resultEvent(over: Json = {}): Json {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: ANSWER_TEXT,
    usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 30, cache_read_input_tokens: 40 },
    total_cost_usd: 0.02,
    num_turns: 2,
    duration_ms: 1000,
    permission_denials: [],
    ...over,
  };
}

function toolUse(command: string): Json {
  return {
    type: 'assistant',
    message: { id: 'MSG-1', role: 'assistant', content: [{ type: 'tool_use', id: 'TOOL-1', name: 'Bash', input: { command } }], usage: {} },
  };
}

function baseEvents(cell: Cell, rate: RateOptions): Json[] {
  return [initEvent(cell.arm), toolUse('rg -n symbol src'), rateEvent(rate), resultEvent()];
}

interface BuildOptions {
  cells?: Cell[];
  rate?: RateOptions;
  rowOver?: (cell: Cell) => Partial<ResultRow>;
  rowLines?: (lines: string[]) => string[];
  attempts?: (records: Json[]) => Json[];
  meta?: (records: Json[]) => Json[];
  events?: (cell: Cell, events: Json[]) => Json[];
  skipStream?: (cell: Cell) => boolean;
}

function writeLines(file: string, lines: readonly string[]): void {
  fs.writeFileSync(file, lines.length === 0 ? '' : `${lines.join('\n')}\n`);
}

function buildRun(dir: string, options: BuildOptions = {}): string {
  const cells = options.cells ?? DEFAULT_CELLS;
  fs.mkdirSync(path.join(dir, 'streams'), { recursive: true });
  const rowLines = cells.map((cell) => JSON.stringify(makeRow(cell, options.rowOver?.(cell))));
  writeLines(path.join(dir, 'results.jsonl'), options.rowLines === undefined ? rowLines : options.rowLines(rowLines));
  const attempts: Json[] = cells.map((cell) => ({
    kind: 'attempt',
    cellId: cellKey(cell),
    attempt: 1,
    status: 'ok',
    infrastructureFailure: false,
    retried: false,
    toolCalls: 1,
    wallMs: 8000,
    rawStreamPath: `/somewhere/${streamName(cell)}`,
    reason: null,
  }));
  const keptAttempts = options.attempts === undefined ? attempts : options.attempts(attempts);
  writeLines(path.join(dir, 'attempts.jsonl'), keptAttempts.map((record) => JSON.stringify(record)));
  const meta: Json[] = [{ kind: 'run_start', at: '2026-10-20T00:00:00Z' }];
  const keptMeta = options.meta === undefined ? meta : options.meta(meta);
  writeLines(path.join(dir, 'sessions.meta.jsonl'), keptMeta.map((record) => JSON.stringify(record)));
  for (const cell of cells) {
    if (options.skipStream?.(cell) === true) continue;
    const events = baseEvents(cell, options.rate ?? {});
    const finalEvents = options.events === undefined ? events : options.events(cell, events);
    writeLines(path.join(dir, 'streams', streamName(cell)), finalEvents.map((event) => JSON.stringify(event)));
  }
  return dir;
}

function check(options: BuildOptions = {}, extra: { streamsOnly?: boolean; originalMeanWallMs?: number; final?: boolean } = {}): { result: CheckResult; dir: string } {
  const dir = buildRun(tmpDir('run'), options);
  const result = checkResultsDir({ outDir: dir, originalMeanWallMs: ORIGINAL_MEAN_WALL_MS, now: new Date('2026-10-20T12:00:00Z'), ...extra });
  return { result, dir };
}

function stopCodes(result: CheckResult): string[] {
  return result.findings.filter((finding) => finding.severity === 'stop').map((finding) => finding.code).sort();
}
function warningCodes(result: CheckResult): string[] {
  return result.findings.filter((finding) => finding.severity === 'warning').map((finding) => finding.code).sort();
}

function assertOnlyStop(options: BuildOptions, code: string, label: string): CheckResult {
  const { result, dir } = check(options);
  assert.deepEqual(stopCodes(result), [code], `${label}: stop codes ${JSON.stringify(result.findings)}`);
  assert.equal(result.ok, false, label);
  for (const finding of result.findings) {
    assert.ok(!finding.detail.includes(ANSWER_TEXT), `${label}: detail echoes answer text`);
    assert.ok(!finding.detail.includes(dir), `${label}: detail carries the results path`);
    assert.ok(!/\/(?:home|Users|private|tmp|var)\//.test(finding.detail), `${label}: detail carries a path: ${finding.detail}`);
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// init-signature

describe('init-signature', () => {
  test('init signature equals the registered environments', () => {
    const prereg = readPrereg(PREREG_FILE);
    assert.equal(EXPECTED_INIT.atlas.tools.length, 11);
    assert.equal(EXPECTED_INIT.grep.tools.length, 3);
    assert.deepEqual(
      [...EXPECTED_INIT.atlas.tools].sort(),
      ['Bash', 'Read', 'Skill', 'StructuredOutput', ...ATLAS_TOOL_NAMES].sort(),
    );
    assert.deepEqual([...EXPECTED_INIT.grep.tools].sort(), ['Bash', 'Read', 'StructuredOutput']);
    for (const arm of ['atlas', 'grep'] as const) {
      const expected = EXPECTED_INIT[arm];
      assert.equal(expected.agents.length, 5);
      assert.deepEqual([...expected.agents].sort(), ['Explore', 'Plan', 'claude', 'general-purpose', 'statusline-setup']);
      assert.equal(expected.apiKeySource, 'none');
      assert.equal(expected.permissionMode, 'default');
      assert.equal(expected.claudeCodeVersion, prereg.params.claudeVersion);
      assert.equal(expected.model, prereg.params.model);
    }
    assert.deepEqual(EXPECTED_INIT.atlas.mcpServers, [{ name: 'gsd-atlas', status: 'connected' }]);
    assert.deepEqual(EXPECTED_INIT.grep.mcpServers, []);
    assert.deepEqual(EXPECTED_INIT.atlas.skills, ['gsd-atlas-eval:gsd-atlas']);
    assert.equal(EXPECTED_INIT.grep.skills.length, 19);
    assert.deepEqual(
      [...EXPECTED_INIT.atlas.plugins].sort(),
      ['cc-plugin-agents-md', 'cc-plugin-plugin-authoring', 'cc-plugin-telemetry', 'gsd-atlas-eval'],
    );
    assert.deepEqual(
      [...EXPECTED_INIT.grep.plugins].sort(),
      ['cc-plugin-agents-md', 'cc-plugin-plugin-authoring', 'cc-plugin-telemetry'],
    );
    // The signature each arm expects reads back from its own init event with no difference.
    for (const arm of ['atlas', 'grep'] as const) {
      assert.deepEqual(diffSignature(arm, signatureOf(initEvent(arm))), []);
    }
  });

  test('init signature of the committed grep-arm stream matches the registered non-tool fields', { skip: !fs.existsSync(OK_FIXTURE) }, () => {
    const first = JSON.parse(fs.readFileSync(OK_FIXTURE, 'utf8').split('\n')[0] as string) as unknown;
    const observed = signatureOf(first);
    assert.ok(observed !== null);
    const expected = EXPECTED_INIT.grep;
    assert.deepEqual([...observed.skills].sort(), [...expected.skills].sort());
    assert.deepEqual([...observed.plugins].sort(), [...expected.plugins].sort());
    assert.deepEqual([...observed.agents].sort(), [...expected.agents].sort());
    assert.equal(observed.apiKeySource, expected.apiKeySource);
    assert.equal(observed.claudeCodeVersion, expected.claudeCodeVersion);
    assert.equal(observed.model, expected.model);
    assert.equal(observed.permissionMode, expected.permissionMode);
  });

  test('init signature differences are named', () => {
    const change = (arm: ArmId, mutate: (event: Json) => void): string[] => {
      const event = initEvent(arm);
      mutate(event);
      return diffSignature(arm, signatureOf(event));
    };
    const some = (diffs: string[], ...needles: string[]): boolean => diffs.some((diff) => needles.every((needle) => diff.includes(needle)));
    assert.ok(some(change('atlas', (e) => (e['tools'] as string[]).push('WebFetch')), 'tools', 'WebFetch'));
    assert.ok(some(change('grep', (e) => (e['skills'] as string[]).pop()), 'skills', 'plugin-authoring'));
    assert.ok(some(change('atlas', (e) => (e['skills'] as string[]).splice(0, 1)), 'skills', 'gsd-atlas-eval:gsd-atlas'));
    assert.ok(some(change('grep', (e) => (e['agents'] as string[]).push('extra-agent')), 'agents', 'extra-agent'));
    assert.ok(some(change('grep', (e) => (e['apiKeySource'] = 'user')), 'apiKeySource', 'user'));
    assert.ok(some(change('grep', (e) => (e['claude_code_version'] = '2.1.303')), 'claude_code_version', '2.1.303'));
    assert.ok(some(change('grep', (e) => (e['plugins'] as Json[]).push({ name: 'rogue', path: 'x', source: 'x' })), 'plugins', 'rogue'));
    assert.ok(some(change('atlas', (e) => (e['mcp_servers'] as Json[]).push({ name: 'other', status: 'connected' })), 'mcpServers', 'other'));
    assert.ok(some(change('grep', (e) => (e['model'] = 'other-model')), 'model', 'other-model'));
    assert.ok(some(change('grep', (e) => (e['permissionMode'] = 'bypassPermissions')), 'permissionMode', 'bypassPermissions'));
    assert.ok(some(change('atlas', (e) => ((e['mcp_servers'] as Json[])[0] as Json)['status'] = 'failed'), 'mcpServers', 'failed'));
    // The order of every list is ignored.
    assert.deepEqual(change('atlas', (e) => {
      (e['tools'] as string[]).reverse();
      (e['plugins'] as Json[]).reverse();
      (e['agents'] as string[]).reverse();
    }), []);
    // An absent init event is a difference, and a non-init event has no signature.
    assert.deepEqual(diffSignature('grep', null), ['init event absent']);
    assert.equal(signatureOf({ type: 'assistant' }), null);
  });
});

// ---------------------------------------------------------------------------------------------
// check-chunk

describe('check-chunk', () => {
  test('check-chunk passes a clean directory', () => {
    const { result } = check();
    assert.equal(result.ok, true, JSON.stringify(result.findings));
    assert.deepEqual(result.findings, []);
    assert.equal(result.counts.rows, 4);
    assert.equal(result.counts.attempts, 4);
    assert.equal(result.counts.streams, 4);
    assert.equal(result.headroom.fiveHour, 0.28);
    assert.equal(result.headroom.sevenDay, 0.56);
    assert.equal(result.headroom.status, 'allowed_warning');
    assert.equal(new Date(result.headroom.fiveHourResetsAt ?? '').getTime(), 1792299000 * 1000);
    assert.equal(new Date(result.headroom.sevenDayResetsAt ?? '').getTime(), 1792537200 * 1000);
    assert.equal(result.wall.meanMs, 8000);
  });

  test('check-chunk stops on row_invalid', () => {
    assertOnlyStop(
      {
        rowLines: (lines) => {
          const broken = JSON.parse(lines[0] as string) as Json;
          broken['billableTokens'] = 999;
          return [JSON.stringify(broken), ...lines.slice(1)];
        },
      },
      'row_invalid',
      'row_invalid',
    );
  });

  test('check-chunk stops on duplicate_cell', () => {
    assertOnlyStop(
      {
        rowLines: (lines) => [lines[0] as string, ...lines],
        attempts: (records) => [records[0] as Json, ...records],
      },
      'duplicate_cell',
      'duplicate_cell',
    );
  });

  test('check-chunk stops on non_ok_session', () => {
    assertOnlyStop(
      { rowOver: (cell) => (cellKey(cell) === 'q-001|atlas|1' ? { status: 'timeout', correct: false } : {}) },
      'non_ok_session',
      'non_ok_session',
    );
  });

  test('check-chunk stops on infrastructure_failure', () => {
    assertOnlyStop(
      { attempts: (records) => records.map((record, index) => (index === 1 ? { ...record, infrastructureFailure: true, reason: 'limit' } : record)) },
      'infrastructure_failure',
      'infrastructure_failure (attempt flag)',
    );
    const { result } = check({
      rowOver: (cell) => (cellKey(cell) === 'q-001|grep|1' ? { status: 'error', correct: false } : {}),
      events: (cell, events) =>
        cellKey(cell) === 'q-001|grep|1'
          ? events.map((event) => (event['type'] === 'result' ? resultEvent({ is_error: true, subtype: 'error_during_execution', result: 'You have hit your usage limit' }) : event))
          : events,
    });
    assert.ok(stopCodes(result).includes('infrastructure_failure'), JSON.stringify(result.findings));
    for (const finding of result.findings) assert.ok(!finding.detail.includes('usage limit'), 'the result text is not echoed');
  });

  test('check-chunk stops on retry_used', () => {
    assertOnlyStop(
      { attempts: (records) => [...records, { ...(records[0] as Json), attempt: 2 }] },
      'retry_used',
      'retry_used',
    );
  });

  test('check-chunk stops on contaminated', () => {
    assertOnlyStop(
      { meta: (records) => [...records, { kind: 'contaminated', cellId: 'q-001|atlas|1', attempt: 1, diffs: ['extra tool: X'], sessionDir: '/private/tmp/x/session', rawStreamPath: '/private/tmp/x/s.jsonl' }] },
      'contaminated',
      'contaminated',
    );
  });

  test('check-chunk stops on prep_failed', () => {
    assertOnlyStop(
      { meta: (records) => [...records, { kind: 'prep_failed', cellId: 'q-002|atlas|1', sessionDir: '/private/tmp/x/session', detail: 'build exited 1: /home/user/x' }] },
      'prep_failed',
      'prep_failed',
    );
  });

  test('check-chunk stops on init_mismatch', () => {
    assertOnlyStop(
      {
        events: (cell, events) =>
          cellKey(cell) === 'q-002|atlas|1'
            ? events.map((event) => (event['subtype'] === 'init' ? { ...event, tools: [...(event['tools'] as string[]), 'WebFetch'] } : event))
            : events,
      },
      'init_mismatch',
      'init_mismatch',
    );
  });

  test('check-chunk stops on hook_event', () => {
    assertOnlyStop(
      {
        events: (cell, events) =>
          cellKey(cell) === 'q-001|grep|1' ? [events[0] as Json, { type: 'system', subtype: 'hook_started', hook_name: 'PreToolUse' }, ...events.slice(1)] : events,
      },
      'hook_event',
      'hook_event',
    );
  });

  test('check-chunk stops on rate_limit_rejected', () => {
    assertOnlyStop(
      {
        events: (cell, events) =>
          cellKey(cell) === 'q-001|atlas|1' ? events.map((event) => (event['type'] === 'rate_limit_event' ? rateEvent({ status: 'rejected' }) : event)) : events,
      },
      'rate_limit_rejected',
      'rate_limit_rejected',
    );
  });

  test('check-chunk stops on overage_in_use', () => {
    assertOnlyStop({ rate: { isUsingOverage: true } }, 'overage_in_use', 'overage_in_use');
  });

  test('check-chunk stops on overage_enabled', () => {
    assertOnlyStop({ rate: { overageEnabled: true } }, 'overage_enabled', 'overage_enabled');
  });

  test('check-chunk stops on headroom_low (seven-day 0.93)', () => {
    const result = assertOnlyStop({ rate: { sevenDay: 0.93 } }, 'headroom_low', 'headroom_low seven-day');
    assert.equal(result.headroom.sevenDay, 0.93);
  });

  test('check-chunk stops on headroom_low (five-hour 0.75)', () => {
    assertOnlyStop({ rate: { fiveHour: 0.75 } }, 'headroom_low', 'headroom_low five-hour');
  });

  test('check-chunk stops on credential_access', () => {
    assertOnlyStop(
      {
        events: (cell, events) =>
          cellKey(cell) === 'q-002|grep|1' ? [events[0] as Json, toolUse('cat /home/cleanroom/.claude/.credentials.json'), ...events.slice(1)] : events,
      },
      'credential_access',
      'credential_access',
    );
  });

  test('check-chunk stops on stream_missing', () => {
    assertOnlyStop({ skipStream: (cell) => cellKey(cell) === 'q-002|atlas|1' }, 'stream_missing', 'stream_missing');
  });

  test('check-chunk warns on slow sessions', () => {
    const slow = check({ rowOver: () => ({ wallMs: 3 * ORIGINAL_MEAN_WALL_MS + 1000 }) });
    assert.equal(slow.result.ok, true);
    assert.deepEqual(warningCodes(slow.result), ['wall_slow']);
    const fast = check();
    assert.deepEqual(warningCodes(fast.result), []);
    const cleanup = check({ meta: (records) => [...records, { kind: 'cleanup_failed', cellId: 'q-001|atlas|1', dir: '/private/tmp/x', error: 'EBUSY' }] });
    assert.equal(cleanup.result.ok, true);
    assert.deepEqual(warningCodes(cleanup.result), ['cleanup_failed']);
    const denied = check({
      events: (_cell, events) => events.map((event) => (event['type'] === 'result' ? resultEvent({ permission_denials: [{ tool_name: 'Bash' }] }) : event)),
    });
    assert.equal(denied.result.ok, true);
    assert.deepEqual(warningCodes(denied.result), ['permission_denied_high']);
    const stale = check({ events: (_cell, events) => events.filter((event) => event['type'] !== 'rate_limit_event') });
    assert.equal(stale.result.ok, true);
    assert.deepEqual(warningCodes(stale.result), ['stale_headroom']);
  });

  test('check-chunk --streams-only reads only the streams directory', () => {
    const dir = tmpDir('streams-only');
    fs.mkdirSync(path.join(dir, 'streams'));
    for (const cell of DEFAULT_CELLS.slice(0, 2)) {
      writeLines(path.join(dir, 'streams', streamName(cell)), baseEvents(cell, {}).map((event) => JSON.stringify(event)));
    }
    const clean = checkResultsDir({ outDir: dir, streamsOnly: true, now: new Date('2026-10-20T12:00:00Z') });
    assert.equal(clean.ok, true, JSON.stringify(clean.findings));
    assert.equal(clean.counts.streams, 2);
    assert.equal(clean.headroom.sevenDay, 0.56);
    const hooked = tmpDir('streams-only-hook');
    fs.mkdirSync(path.join(hooked, 'streams'));
    writeLines(path.join(hooked, 'streams', streamName(DEFAULT_CELLS[0] as Cell)), [
      ...baseEvents(DEFAULT_CELLS[0] as Cell, {}).map((event) => JSON.stringify(event)),
      JSON.stringify({ type: 'system', subtype: 'hook_response' }),
    ]);
    assert.deepEqual(stopCodes(checkResultsDir({ outDir: hooked, streamsOnly: true })), ['hook_event']);
  });

  test('check-chunk --final requires 450 rows', () => {
    const { result } = check({}, { final: true });
    assert.equal(result.ok, false);
    assert.ok(result.findings.some((finding) => finding.severity === 'stop' && finding.detail.includes('450')), JSON.stringify(result.findings));
  });

  test('check-chunk discard-after moves only later rows and needs --yes', () => {
    const dir = buildRun(tmpDir('discard'));
    const before = fs.readFileSync(path.join(dir, 'results.jsonl'), 'utf8');
    const now = new Date('2026-10-20T12:00:00Z');
    const dry = discardAfter({ outDir: dir, after: 2, reason: 'rate limit in chunk', yes: false, now });
    assert.equal(dry.moved, false);
    assert.equal(dry.rows, 2);
    assert.equal(fs.readFileSync(path.join(dir, 'results.jsonl'), 'utf8'), before, 'a dry run changes nothing');
    assert.deepEqual(fs.readdirSync(dir).filter((name) => name.startsWith('discarded-')), []);
    assert.equal(fs.readdirSync(path.join(dir, 'streams')).length, 4);

    const done = discardAfter({ outDir: dir, after: 2, reason: 'rate limit in chunk', yes: true, now });
    assert.equal(done.moved, true);
    const kept = fs.readFileSync(path.join(dir, 'results.jsonl'), 'utf8').trim().split('\n');
    assert.equal(kept.length, 2);
    assert.deepEqual(kept, before.trim().split('\n').slice(0, 2), 'earlier rows are untouched');
    const stamped = fs.readdirSync(dir).filter((name) => name.startsWith('discarded-'));
    assert.equal(stamped.length, 1);
    const moved = path.join(dir, stamped[0] as string);
    assert.deepEqual(fs.readFileSync(path.join(moved, 'results.jsonl'), 'utf8').trim().split('\n'), before.trim().split('\n').slice(2));
    const info = JSON.parse(fs.readFileSync(path.join(moved, 'discarded.json'), 'utf8')) as Json;
    assert.equal(info['reason'], 'rate limit in chunk');
    assert.equal(info['rows'], 2);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'streams')).sort(), [streamName(DEFAULT_CELLS[0] as Cell), streamName(DEFAULT_CELLS[1] as Cell)].sort());
    assert.deepEqual(fs.readdirSync(path.join(moved, 'streams')).sort(), [streamName(DEFAULT_CELLS[2] as Cell), streamName(DEFAULT_CELLS[3] as Cell)].sort());
    // The attempt records of the moved cells go with them, so a rerun is not counted as a retry.
    const attemptsLeft = fs.readFileSync(path.join(dir, 'attempts.jsonl'), 'utf8').trim().split('\n');
    assert.equal(attemptsLeft.length, 2);
    const after = checkResultsDir({ outDir: dir, now });
    assert.equal(after.ok, true, JSON.stringify(after.findings));
    assert.equal(after.counts.rows, 2);
  });

  test('check-chunk discard-after through the command line', () => {
    const dir = buildRun(tmpDir('discard-cli'));
    const dry = runScript('check-chunk.ts', ['--out-dir', dir, '--discard-after', '3', '--reason', 'test']);
    assert.equal(dry.code, 0, dry.stderr);
    assert.match(dry.stdout, /would move/);
    assert.equal(fs.readFileSync(path.join(dir, 'results.jsonl'), 'utf8').trim().split('\n').length, 4);
    const noReason = runScript('check-chunk.ts', ['--out-dir', dir, '--discard-after', '3', '--yes']);
    assert.equal(noReason.code, 2);
    const yes = runScript('check-chunk.ts', ['--out-dir', dir, '--discard-after', '3', '--reason', 'test', '--yes']);
    assert.equal(yes.code, 0, yes.stderr);
    assert.equal(fs.readFileSync(path.join(dir, 'results.jsonl'), 'utf8').trim().split('\n').length, 3);
  });

  test('check-chunk command line prints one line per finding and a final verdict', () => {
    const clean = buildRun(tmpDir('cli-clean'));
    const ok = runScript('check-chunk.ts', ['--out-dir', clean]);
    assert.equal(ok.code, 0, ok.stderr);
    assert.match(ok.stdout.trim().split('\n').at(-1) as string, /^check: ok$/);
    const bad = buildRun(tmpDir('cli-bad'), { rate: { isUsingOverage: true } });
    const stop = runScript('check-chunk.ts', ['--out-dir', bad]);
    assert.equal(stop.code, 1);
    assert.match(stop.stdout, /overage_in_use/);
    assert.match(stop.stdout.trim().split('\n').at(-1) as string, /^check: stop$/);
    assert.ok(!stop.stdout.includes(ANSWER_TEXT));
  });

  test('check-chunk on an empty directory under --streams-only is a clean stop, not a stack trace', () => {
    const empty = tmpDir('empty');
    const done = runScript('check-chunk.ts', ['--out-dir', empty, '--streams-only']);
    assert.equal(done.code, 1);
    assert.match(done.stdout, /stream_missing/);
    assert.match(done.stdout.trim().split('\n').at(-1) as string, /^check: stop$/);
    assert.ok(!/\n\s+at /.test(done.stderr + done.stdout), 'no stack trace');
    const missing = runScript('check-chunk.ts', ['--out-dir', path.join(empty, 'does-not-exist'), '--streams-only']);
    assert.equal(missing.code, 1);
    assert.ok(!/\n\s+at /.test(missing.stderr + missing.stdout), 'no stack trace');
  });

  test('every command line prints its usage and exits 0 on --help', () => {
    for (const name of ['check-chunk.ts', 'compare.ts', 'scrub.ts', 'probe.ts']) {
      const done = runScript(name, ['--help']);
      assert.equal(done.code, 0, `${name}: ${done.stderr}`);
      assert.match(done.stdout, /usage:/i, name);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// compare

function loadOriginal(): ResultRow[] {
  return fs
    .readFileSync(ORIGINAL_FILE, 'utf8')
    .trim()
    .split('\n')
    .map((line) => ResultRowSchema.parse(JSON.parse(line)));
}
function withUsage(row: ResultRow, scale: (value: number) => number): ResultRow {
  const usage = {
    input: scale(row.usage.input),
    output: scale(row.usage.output),
    cacheCreation: scale(row.usage.cacheCreation),
    cacheRead: scale(row.usage.cacheRead),
  };
  return { ...row, usage, billableTokens: usage.input + usage.output + usage.cacheCreation + usage.cacheRead };
}

describe('compare', { skip: HAVE_ORIGINAL ? false : 'docs/eval/results/results.jsonl is not in this checkout' }, () => {
  const prereg = readPrereg(PREREG_FILE);

  test('compare: the original against itself is strong agreement', () => {
    const original = loadOriginal();
    assert.equal(original.length, 450);
    const comparison = compareRuns(original, original, prereg);
    assert.equal(comparison.classification, 'strong-agreement');
    assert.equal(comparison.validity.state, 'valid');
    assert.deepEqual(comparison.validity.reasons, []);
    assert.ok(comparison.a1 !== null && comparison.a2 !== null);
    // The registered outcomes of the original: accuracy met, tokens not met, citations not met.
    assert.equal(comparison.a1.accuracy.original, true);
    assert.equal(comparison.a1.tokens.original, false);
    assert.equal(comparison.a1.citations.original, false);
    for (const key of ['accuracy', 'tokens', 'citations'] as const) {
      assert.equal(comparison.a1[key].agree, true, key);
      assert.equal(comparison.a2[key].difference, 0, key);
      assert.equal(comparison.a2[key].lower, 0, key);
      assert.equal(comparison.a2[key].upper, 0, key);
      assert.equal(comparison.a2[key].compatible, true, key);
    }
    assert.equal(comparison.reported.flips.atlas.correctness, 0);
    assert.equal(comparison.reported.flips.grep.correctness, 0);
    // The original's registered figures (analysis.md): ratio 1.612, citations 144 of 198, atlas tool use 86 of 225, no skill load.
    assert.ok(Math.abs(comparison.reported.tokenRatio.original - 1.612) < 0.001, String(comparison.reported.tokenRatio.original));
    assert.equal(comparison.reported.citations.atlas.original.verifiable, 144);
    assert.equal(comparison.reported.citations.atlas.original.sessions, 198);
    assert.equal(comparison.reported.atlasToolUse.original.sessions, 86);
    assert.equal(comparison.reported.skillLoads.original.sessions, 0);
  });

  test('compare: scaled atlas tokens flip H2 to disagreement', () => {
    const original = loadOriginal();
    const replication = original.map((row) => (row.arm === 'atlas' ? withUsage(row, (value) => Math.round(value * 0.4)) : row));
    const comparison = compareRuns(original, replication, prereg);
    assert.equal(comparison.classification, 'disagreement');
    assert.ok(comparison.a1 !== null);
    assert.equal(comparison.a1.tokens.agree, false);
    assert.equal(comparison.a1.tokens.replication, true);
    assert.equal(comparison.a1.accuracy.agree, true);
    assert.equal(comparison.a1.citations.agree, true);
    assert.deepEqual(comparison.disagreements, ['tokens']);
    const markdown = renderComparison(comparison);
    assert.match(markdown, /classification: disagreement/);
  });

  test('compare: a timed-out session is degraded and inconclusive', () => {
    const original = loadOriginal();
    const replication = original.map((row, index) => (index === 10 ? { ...row, status: 'timeout' as const, correct: false } : row));
    const comparison = compareRuns(original, replication, prereg);
    assert.equal(comparison.classification, 'inconclusive');
    assert.equal(comparison.validity.state, 'degraded');
    assert.ok(comparison.validity.reasons.some((reason) => reason.includes('timeout')), JSON.stringify(comparison.validity));
  });

  test('compare: a missing row is invalid', () => {
    const original = loadOriginal();
    const replication = original.slice(1);
    const comparison = compareRuns(original, replication, prereg);
    assert.equal(comparison.classification, 'inconclusive');
    assert.equal(comparison.validity.state, 'invalid');
    assert.ok(comparison.validity.reasons.some((reason) => reason.includes('449')), JSON.stringify(comparison.validity));
    const duplicated = compareRuns(original, [...original.slice(1), original[1] as ResultRow], prereg);
    assert.equal(duplicated.validity.state, 'invalid');
    const extra = compareRuns(original, [...original, { ...(original[0] as ResultRow), run: 4 }], prereg);
    assert.equal(extra.validity.state, 'invalid');
  });

  test('compare: extra validity reasons from the stream check make the replication invalid', () => {
    const original = loadOriginal();
    const comparison = compareRuns(original, original, prereg, { invalidReasons: ['hook_event: a hook event in one stream'] });
    assert.equal(comparison.classification, 'inconclusive');
    assert.equal(comparison.validity.state, 'invalid');
    assert.ok(comparison.validity.reasons.some((reason) => reason.includes('hook_event')));
  });

  test('compare: opposite single flips stay strong agreement', () => {
    const original = loadOriginal();
    const atlasIndex = original.findIndex((row) => row.arm === 'atlas' && row.correct && row.status === 'ok');
    const atlasQuestion = (original[atlasIndex] as ResultRow).questionId;
    const grepIndex = original.findIndex((row) => row.arm === 'grep' && row.correct && row.status === 'ok' && row.questionId !== atlasQuestion);
    assert.ok(atlasIndex >= 0 && grepIndex >= 0);
    const replication = original.map((row, index) => (index === atlasIndex || index === grepIndex ? { ...row, correct: false } : row));
    const comparison = compareRuns(original, replication, prereg);
    assert.equal(comparison.classification, 'strong-agreement');
    assert.equal(comparison.reported.flips.atlas.correctness, 1);
    assert.equal(comparison.reported.flips.grep.correctness, 1);
    // The two flips move S1 in opposite directions, so the mean difference nets out while the cell flips are counted.
    assert.ok(comparison.a2 !== null && comparison.a2.accuracy.compatible);
    assert.ok(Math.abs(comparison.a2.accuracy.difference) < 1e-9);
  });

  test('compare: a uniform 3 percent token shift is agreement with drift', () => {
    const original = loadOriginal();
    const replication = original.map((row) => (row.arm === 'atlas' ? withUsage(row, (value) => Math.round(value * 1.03)) : row));
    const comparison = compareRuns(original, replication, prereg);
    assert.equal(comparison.classification, 'agreement-with-drift');
    assert.ok(comparison.a1 !== null);
    for (const key of ['accuracy', 'tokens', 'citations'] as const) assert.equal(comparison.a1[key].agree, true, key);
    assert.deepEqual(comparison.drift, ['tokens']);
    const markdown = renderComparison(comparison);
    assert.match(markdown, /classification: agreement-with-drift/);
    assert.match(markdown, /tokens/);
  });

  test('compare: the rules are the registered constants and the seed equals the registered seed', () => {
    assert.deepEqual({ ...AGREEMENT_RULES }, { resamples: 10000, seed: 20261017, lower: 0.025, upper: 0.975 });
    assert.equal(AGREEMENT_RULES.seed, prereg.params.seed);
    assert.equal(AGREEMENT_RULES.resamples, prereg.params.resamples);
  });

  test('compare: the declared differences name the Node version of both runs and do not change the class', () => {
    const node = DECLARED_DIFFERENCES.find((entry) => entry.id === 'node');
    assert.ok(node !== undefined);
    assert.equal(node.original, '26.11.1');
    for (const id of ['node', 'os', 'limits', 'user-config', 'network', 'time']) {
      assert.ok(DECLARED_DIFFERENCES.some((entry) => entry.id === id), id);
    }
    const original = loadOriginal();
    const comparison = compareRuns(original, original, prereg);
    const withoutFile = renderComparison(comparison);
    assert.match(withoutFile, /26\.11\.1/);
    assert.match(withoutFile, /see environment\.json/);
    const withFile = renderComparison(comparison, { node: '24.22.0' });
    assert.match(withFile, /26\.11\.1/);
    assert.match(withFile, /24\.22\.0/);
    const classOf = (text: string): string | undefined => /classification: (\S+)/.exec(text)?.[1];
    assert.equal(classOf(withFile), classOf(withoutFile));
    assert.equal(classOf(withFile), comparison.classification);
    // The markdown opens with the declared differences, before any figure.
    const lines = withFile.split('\n');
    const tableAt = lines.findIndex((line) => line.includes('26.11.1'));
    const classificationAt = lines.findIndex((line) => line.startsWith('classification:'));
    assert.ok(tableAt >= 0 && classificationAt > tableAt, `declared differences at ${String(tableAt)}, classification at ${String(classificationAt)}`);
    assert.match(withFile, /neither corrected for nor isolated/);
  });

  test('compare command line: the committed original against itself', () => {
    const out = path.join(tmpDir('compare-cli'), 'self.md');
    const json = path.join(path.dirname(out), 'self.json');
    const env = path.join(path.dirname(out), 'environment.json');
    fs.writeFileSync(env, `${JSON.stringify({ node: '24.22.0' })}\n`);
    const done = runScript('compare.ts', ['--original', ORIGINAL_FILE, '--replication', ORIGINAL_FILE, '--out', out, '--json', json, '--environment', env]);
    assert.equal(done.code, 0, done.stderr);
    assert.match(done.stdout, /classification: strong-agreement/);
    const markdown = fs.readFileSync(out, 'utf8');
    assert.match(markdown, /24\.22\.0/);
    assert.match(markdown, /26\.11\.1/);
    const parsed = JSON.parse(fs.readFileSync(json, 'utf8')) as Json;
    assert.equal(parsed['classification'], 'strong-agreement');
  });
});

// ---------------------------------------------------------------------------------------------
// scrub

describe('scrub', () => {
  test('scrub replaces paths and finds leaks', () => {
    const text = [
      'run /work/cleanroom-run/streams/a.jsonl',
      'work /work/gsd-atlas/src',
      'home /home/cleanroom/.claude/x',
      'tmp /work/tmp/session-1/repo',
    ].join('\n');
    const scrubbed = scrubText(text, { run: '/work/cleanroom-run', work: '/work', home: '/home/cleanroom', tmp: '/work/tmp' });
    assert.equal(
      scrubbed,
      ['run <run>/streams/a.jsonl', 'work <work>/gsd-atlas/src', 'home <home>/.claude/x', 'tmp <tmp>/session-1/repo'].join('\n'),
    );
    assert.deepEqual(findLeaks(scrubbed, { deny: [] }), []);
    assert.deepEqual(findLeaks('rows 450, tokens 47375, sha 2cde1571398a1417256cd7fcdb7fc5114e7dd642d925a060443fd705b8b2032d', { deny: [] }), []);

    const rules = (value: string, deny: string[] = []): string[] => findLeaks(value, { deny }).map((leak) => leak.rule);
    assert.ok(rules('see /home/someone/file').includes('home-path'));
    assert.ok(rules('see /Users/someone/file').includes('home-path'));
    assert.ok(rules('see /private/var/x').includes('home-path'));
    assert.ok(rules('see C:\\Users\\someone\\x').includes('home-path'));
    assert.ok(rules('see /tmp/x/y').includes('temp-path'));
    assert.ok(rules('see /var/folders/ab/cd').includes('temp-path'));
    assert.ok(rules('mail someone@example.org').includes('email'));
    assert.ok(rules(`key ${'s' + 'k-'}${'a1B2'.repeat(8)}`).includes('token'));
    for (const prefix of ['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_', 'github_pat_']) {
      assert.ok(rules(`t ${prefix}${'x'.repeat(36)}`).includes('token'), prefix);
    }
    assert.ok(rules(`id ${'AK' + 'IA'}${'ABCDEFGH12345678'}`).includes('token'));
    assert.ok(rules(`-----BEGIN ${'RSA PRIVATE'} KEY-----`).includes('token'));
    assert.ok(rules('talks to Example-Host.local', ['example-host.local']).includes('deny'));
    assert.ok(rules('a raw transcript').includes('raw-session-text'));
    // A leak report names the rule and the line, never the matched text.
    const leaks = findLeaks('line one\nmail someone@example.org', { deny: [] });
    assert.equal(leaks[0]?.line, 2);
    assert.ok(!JSON.stringify(leaks).includes('someone@example.org'));
  });

  test('scrub command line checks files and directories against the deny list', () => {
    const dir = tmpDir('scrub-cli');
    fs.writeFileSync(path.join(dir, 'clean.md'), 'rows 450\n');
    const clean = runScript('scrub.ts', ['--check', dir]);
    assert.equal(clean.code, 0, clean.stdout + clean.stderr);
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'sub', 'leak.md'), 'see /home/someone/x and docker.example.test\n');
    const leaked = runScript('scrub.ts', ['--check', dir, '--deny-env', 'CLEANROOM_TEST_DENY'], { CLEANROOM_TEST_DENY: 'zq9user@docker.example.test' });
    assert.equal(leaked.code, 1);
    assert.match(leaked.stdout, /leak\.md/);
    assert.match(leaked.stdout, /home-path/);
    assert.match(leaked.stdout, /deny/);
    assert.ok(!(leaked.stdout + leaked.stderr).includes('docker.example.test'), 'the deny value is never printed');
    assert.ok(!(leaked.stdout + leaked.stderr).includes('zq9user'), 'neither part of user@host is printed');
    // --deny-only skips the path rules but still applies the deny list, tokens and emails.
    const only = runScript('scrub.ts', ['--check', path.join(dir, 'sub'), '--deny-only']);
    assert.equal(only.code, 0, only.stdout + only.stderr);
    const onlyDeny = runScript('scrub.ts', ['--check', path.join(dir, 'sub'), '--deny-only', '--deny-env', 'CLEANROOM_TEST_DENY'], { CLEANROOM_TEST_DENY: 'zq9user@docker.example.test' });
    assert.equal(onlyDeny.code, 1);
    const nothing = runScript('scrub.ts', []);
    assert.equal(nothing.code, 2);
  });
});

// ---------------------------------------------------------------------------------------------
// The image, the notes file and the control script (content cases; nothing is built)

const DOCKER_DIR = path.join(REPO, 'docker', 'cleanroom');
const readDocker = (name: string): string => fs.readFileSync(path.join(DOCKER_DIR, name), 'utf8');
const logical = (text: string): string => text.replace(/\\\n\s*/g, ' ');

const NODE_24_BASE = 'node:24.22.0-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5';
const NODE_26_BASE = 'node:26.12.0-bookworm-slim@sha256:298992629d69bbd5b2b03ad57094d8e4fcb3a8eeb7c4e25d29de656519568913';
const CLAUDE_SHA256 = '60d7eb7f12fbb28a52533fe8be5884097403562aa02dc73991a021c7067e29a5';
const RELEASE_FINGERPRINT = '31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE';

const atLeast = (version: string, floor: string): boolean => {
  const a = version.split('.').map(Number);
  const b = floor.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
};

describe('clean-room image', () => {
  test('Dockerfile pins the base image by digest', () => {
    const dockerfile = readDocker('Dockerfile');
    assert.ok(dockerfile.includes(`ARG BASE_IMAGE=${NODE_24_BASE}`), 'the default base is the Node 24.22.0 digest');
    const froms = dockerfile.split('\n').filter((line) => /^FROM\s/i.test(line));
    assert.ok(froms.length >= 2, 'two stages');
    for (const line of froms) assert.match(line, /^FROM \$\{BASE_IMAGE\}( AS [a-z]+)?$/, line);
    assert.ok(!dockerfile.includes('26.12.0'), 'the Dockerfile itself names only the default base');
    const control = readDocker('cleanroomctl.sh');
    assert.equal(control.split(NODE_26_BASE).length - 1, 1, 'the 26.12.0 digest is held once, in the control script');
    const floor = (JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')) as { engines: { node: string } }).engines.node.replace(/^>=/, '');
    for (const base of [NODE_24_BASE, NODE_26_BASE]) {
      const version = /^node:(\d+\.\d+\.\d+)-bookworm-slim@sha256:[0-9a-f]{64}$/.exec(base)?.[1];
      assert.ok(version !== undefined && atLeast(version, floor), `${base} is at or above the engines floor ${floor}`);
    }
  });

  test('Dockerfile installs Claude Code 2.1.302 from the official release URL, verifies the pinned sha256 and the signed manifest and equals the registered claudeVersion', () => {
    const dockerfile = logical(readDocker('Dockerfile'));
    const prereg = readPrereg(PREREG_FILE);
    assert.equal(prereg.params.claudeVersion, '2.1.302');
    assert.ok(dockerfile.includes(`ARG CLAUDE_VERSION=${prereg.params.claudeVersion}`));
    assert.ok(dockerfile.includes(`ARG CLAUDE_SHA256=${CLAUDE_SHA256}`));
    assert.ok(dockerfile.includes(`ARG CLAUDE_RELEASE_FINGERPRINT=${RELEASE_FINGERPRINT}`));
    assert.ok(dockerfile.includes('https://downloads.claude.ai/claude-code-releases/'));
    assert.ok(dockerfile.includes('https://downloads.claude.ai/keys/claude-code.asc'));
    for (const needle of ['manifest.json', 'manifest.json.sig', 'linux-x64', 'gpg', '--verify', 'sha256sum -c', '--with-colons']) {
      assert.ok(dockerfile.includes(needle), needle);
    }
    // The fingerprint and both checksums are compared with the pinned arguments, and a mismatch stops the build.
    assert.match(dockerfile, /test "\$\{fingerprint\}" = "\$\{CLAUDE_RELEASE_FINGERPRINT\}"/);
    assert.match(dockerfile, /test "\$\{manifest_sha\}" = "\$\{CLAUDE_SHA256\}"/);
    assert.match(dockerfile, /echo "\$\{CLAUDE_SHA256\}  claude" \| sha256sum -c -/);
    assert.match(dockerfile, /COPY --from=fetch \/fetch\/claude \/usr\/local\/bin\/claude/);
  });

  test('Dockerfile disables updates and sets no credential or provider variable, no EXPOSE, no ADD from a URL, no secret argument', () => {
    const dockerfile = logical(readDocker('Dockerfile'));
    const names: string[] = [];
    for (const line of dockerfile.split('\n')) {
      const env = /^ENV\s+(.+)$/.exec(line);
      if (env !== null) for (const pair of (env[1] as string).split(/\s+/)) names.push(pair.split('=')[0] as string);
    }
    assert.deepEqual(names.sort(), ['DISABLE_AUTOUPDATER', 'DISABLE_UPDATES', 'HOME', 'TMPDIR']);
    assert.match(dockerfile, /ENV HOME=\/home\/cleanroom TMPDIR=\/work\/tmp DISABLE_UPDATES=1 DISABLE_AUTOUPDATER=1/);
    assert.ok(!/^\s*EXPOSE\b/m.test(dockerfile), 'no EXPOSE');
    assert.ok(!/^\s*ADD\b/m.test(dockerfile), 'no ADD');
    assert.ok(!/^\s*VOLUME\b/m.test(dockerfile), 'no VOLUME');
    for (const line of dockerfile.split('\n')) {
      const arg = /^ARG\s+([A-Za-z0-9_]+)/.exec(line);
      if (arg !== null) assert.ok(!/SECRET|TOKEN|PASSWORD|API_?KEY|CREDENTIAL|AUTH/i.test(arg[1] as string), `ARG ${arg[1] as string}`);
    }
    for (const prefix of ['ANTHROPIC_', 'CLAUDE_CODE_', 'AWS_', 'GOOGLE_', 'AZURE_']) {
      assert.ok(!dockerfile.includes(prefix), prefix);
    }
    const leaks = findLeaks(dockerfile, { deny: [], denyOnly: true });
    assert.deepEqual(leaks, [], 'no token-like string or email address');
  });

  test('Dockerfile runs as a non-root user with a fixed uid', () => {
    const dockerfile = logical(readDocker('Dockerfile'));
    assert.match(dockerfile, /useradd[^\n]*--uid 10001[^\n]*cleanroom/);
    assert.match(dockerfile, /--home-dir \/home\/cleanroom/);
    const users = dockerfile.split('\n').filter((line) => /^USER\s/.test(line));
    assert.deepEqual(users, ['USER cleanroom']);
    assert.match(dockerfile, /^WORKDIR \/work$/m);
    assert.match(dockerfile, /^CMD \["sleep", "infinity"\]$/m);
    assert.match(dockerfile, /LABEL org\.gsd-atlas\.cleanroom\.plan="03-39"/);
  });

  test('Dockerfile installs ripgrep and git and adds no compiler toolchain', () => {
    const dockerfile = logical(readDocker('Dockerfile'));
    const installs = dockerfile.split('\n').filter((line) => /apt-get install/.test(line));
    assert.equal(installs.length, 2, 'one install per stage');
    for (const line of installs) assert.ok(line.includes('--no-install-recommends'), line);
    const finalInstall = installs.at(-1) as string;
    assert.match(finalInstall, /ca-certificates git ripgrep tmux procps jq less/);
    assert.ok(!/\b(build-essential|gcc|g\+\+|make|cmake|clang|python3|node-gyp)\b/.test(dockerfile), 'no compiler toolchain');
    const fetchInstall = installs[0] as string;
    assert.match(fetchInstall, /curl gnupg ca-certificates/);
  });

  test('user-claude.md is the exact neutral text and holds none of the forbidden words', () => {
    const notes = readDocker('user-claude.md');
    assert.equal(notes, '# Notes\n\nThis is a general-purpose Linux development machine.\n');
    for (const word of ['atlas', 'grep', 'codegraph', 'mcp', 'skill', 'hook', 'tool', 'search', 'symbol', 'citation', 'cite', 'token', 'answer', 'question', 'repository']) {
      assert.ok(!notes.toLowerCase().includes(word), word);
    }
  });

  test('cleanroomctl.sh uses only its own object names, labels everything, checks the label before removing, requires CLEANROOM_SSH, and has no prune, no sudo, no wildcard or command-substitution removal, no publish flag, no docker socket mount', () => {
    const raw = readDocker('cleanroomctl.sh');
    const script = logical(raw);
    const own = new Set([
      'gsd-atlas-cleanroom',
      'gsd-atlas-cleanroom:03-39',
      'gsd-atlas-cleanroom-net',
      'gsd-atlas-cleanroom-home',
      'gsd-atlas-cleanroom-work',
    ]);
    for (const match of raw.matchAll(/gsd-atlas-cleanroom[A-Za-z0-9_.:-]*/g)) {
      const name = match[0].replace(/[.:-]+$/, '');
      assert.ok(own.has(name), `${name} is not one of the five own names`);
    }
    for (const name of own) assert.ok(raw.includes(name), name);
    assert.match(raw, /org\.gsd-atlas\.cleanroom\.plan/);
    assert.match(raw, /--label "\$\{LABEL_KEY\}=\$\{LABEL_VALUE\}"/);
    assert.match(raw, /: "\$\{CLEANROOM_SSH:\?/);
    assert.ok(!raw.includes('holodeck'), 'no default host');
    assert.ok(!/\bsudo\b/.test(raw), 'no sudo');
    assert.ok(!/prune/i.test(raw), 'no prune');
    assert.ok(!/docker\s+system/.test(raw), 'no docker system');
    assert.ok(!/docker\.sock/.test(raw), 'no docker socket');
    assert.ok(!/docker logs|docker cp\b/.test(raw), 'no logs and no cp');
    for (const line of script.split('\n').filter((entry) => /docker run/.test(entry))) {
      assert.ok(!/(\s-p\s|--publish|\s-P\s|--privileged)/.test(line), `publish or privileged flag: ${line}`);
      assert.ok(line.includes('--cap-drop ALL'), 'all capabilities dropped');
      assert.ok(line.includes('no-new-privileges:true'), 'no-new-privileges');
      assert.ok(line.includes('--pids-limit') && line.includes('--cpu-shares') && line.includes('--memory-swap'), 'explicit limits');
    }
    // Every removal sits in the one function that reads the label first.
    const removal = /^remove_object\(\) \{\n([\s\S]*?)^\}/m.exec(raw);
    assert.ok(removal !== null, 'a remove_object function');
    const body = removal[1] as string;
    assert.ok(body.indexOf('require_label') >= 0 && body.indexOf('require_label') < body.search(/ rm /), 'the label is read before the removal');
    for (const line of script.split('\n')) {
      if (/\brm\b/.test(line) && /docker/.test(line)) {
        assert.ok(removal[0].includes(line.trim()) || /remove_object/.test(line), `a removal outside remove_object: ${line}`);
      }
      if (/(docker[^\n]*\brm\b|\brm\s)/.test(line)) {
        assert.ok(!/\$\(|\*|`/.test(line.replace(/'[^']*'/g, '')), `wildcard or substitution in a removal: ${line}`);
      }
    }
    // The remote commands take object names from constants, never from the arguments or the environment.
    assert.ok(!/docker (?:container |network |image |volume )?(?:rm|stop|start|restart|kill|exec|inspect)[^\n]*"\$\{?[1-9@*]/.test(script), 'no object name from an argument');
  });

  test('cleanroomctl.sh has no syntax error and answers help without CLEANROOM_SSH', () => {
    const file = path.join(DOCKER_DIR, 'cleanroomctl.sh');
    const syntax = spawnSync('bash', ['-n', file], { encoding: 'utf8' });
    assert.equal(syntax.status, 0, syntax.stderr);
    const env = { ...process.env };
    delete env['CLEANROOM_SSH'];
    const help = spawnSync('bash', [file, 'help'], { encoding: 'utf8', env });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /usage:/i);
    const refused = spawnSync('bash', [file, 'status'], { encoding: 'utf8', env });
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /CLEANROOM_SSH/);
    const bad = spawnSync('bash', [file, 'status'], { encoding: 'utf8', env: { ...env, CLEANROOM_SSH: '-oProxyCommand=x' } });
    assert.notEqual(bad.status, 0, 'an ssh target that looks like an option is refused');
    const unknown = spawnSync('bash', [file, 'prune'], { encoding: 'utf8', env: { ...env, CLEANROOM_SSH: 'host.example.test' } });
    assert.notEqual(unknown.status, 0, 'an unknown subcommand is refused');
  });

  test('the image files carry no host name, token or email address', () => {
    for (const name of ['Dockerfile', 'user-claude.md', 'cleanroomctl.sh']) {
      assert.deepEqual(findLeaks(readDocker(name), { deny: ['nomorestars'], denyOnly: true }), [], name);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// probe

function executable(file: string, text: string): string {
  fs.writeFileSync(file, text, { mode: 0o755 });
  return file;
}

interface ProbeRun {
  code: number | null;
  stdout: string;
  stderr: string;
  argv: string[];
  stdin: string;
  outDir: string;
}

function runProbe(arm: string, events: Json[], extra: string[] = []): ProbeRun {
  const dir = tmpDir('probe');
  const corpus = path.join(dir, 'corpus');
  fs.mkdirSync(corpus);
  fs.writeFileSync(path.join(corpus, 'a.ts'), 'export const a = 1;\n');
  const outDir = path.join(dir, 'out');
  const eventsFile = path.join(dir, 'events.json');
  fs.writeFileSync(eventsFile, JSON.stringify(events));
  const claude = executable(
    path.join(dir, 'claude'),
    [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      "fs.writeFileSync(process.env.FAKE_ARGV_OUT, JSON.stringify(process.argv.slice(2)));",
      "let input = '';",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => {",
      '  fs.writeFileSync(process.env.FAKE_STDIN_OUT, input);',
      "  for (const event of JSON.parse(fs.readFileSync(process.env.FAKE_EVENTS, 'utf8'))) console.log(JSON.stringify(event));",
      '});',
      '',
    ].join('\n'),
  );
  const atlas = executable(path.join(dir, 'fake-gsd-atlas.js'), '#!/usr/bin/env node\nprocess.exit(0);\n');
  const done = runScript('probe.ts', ['--arm', arm, '--corpus-dir', corpus, '--out-dir', outDir, '--claude', claude, '--atlas-bin', atlas, ...extra], {
    FAKE_ARGV_OUT: path.join(dir, 'argv.json'),
    FAKE_STDIN_OUT: path.join(dir, 'stdin.txt'),
    FAKE_EVENTS: eventsFile,
  });
  const read = (file: string): string => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
  const argvText = read(path.join(dir, 'argv.json'));
  return { ...done, argv: argvText === '' ? [] : (JSON.parse(argvText) as string[]), stdin: read(path.join(dir, 'stdin.txt')), outDir };
}

const argAfter = (argv: readonly string[], flag: string): string | undefined => {
  const at = argv.indexOf(flag);
  return at < 0 ? undefined : argv[at + 1];
};

describe('probe', () => {
  const reply = (text: string): Json => resultEvent({ result: text, total_cost_usd: 0.012 });

  test('probe grep arm builds the registered session and reports the compact line', () => {
    const run = runProbe('grep', [initEvent('grep'), rateEvent(), reply('ok')]);
    assert.equal(run.code, 0, run.stderr);
    const lines = run.stdout.trim().split('\n');
    assert.equal(lines.length, 1, 'one compact line');
    const report = JSON.parse(lines[0] as string) as Json;
    assert.equal(report['probe'], 'grep');
    assert.equal(report['status'], 'ok');
    assert.deepEqual(report['signatureDiffs'], []);
    assert.equal(report['apiKeySource'], 'none');
    assert.equal(report['claudeCodeVersion'], '2.1.302');
    assert.equal(report['hookEvents'], 0);
    assert.equal(report['costUsd'], 0.012);
    assert.ok(!('reply' in report), 'arm probes do not print the reply');
    const rate = report['rateLimit'] as Json;
    assert.equal(rate['status'], 'allowed_warning');
    assert.equal(rate['fiveHour'], 0.28);
    assert.equal(rate['sevenDay'], 0.56);
    assert.equal(rate['isUsingOverage'], false);
    assert.ok(!run.stdout.includes('/'), 'no path in the line');
    assert.equal(run.stdin, 'Reply with the single word ok.');
    assert.equal(argAfter(run.argv, '--setting-sources'), '');
    assert.ok(run.argv.includes('--strict-mcp-config'));
    assert.equal(argAfter(run.argv, '--tools'), 'Bash,Read');
    assert.equal(argAfter(run.argv, '--max-budget-usd'), '0.05');
    assert.equal(argAfter(run.argv, '--model'), 'claude-sonnet-5-5');
    assert.ok(argAfter(run.argv, '--json-schema')?.includes('"items"'));
    assert.ok(!run.argv.includes('--plugin-dir') && !run.argv.includes('--settings'));
    assert.ok(fs.existsSync(path.join(run.outDir, 'streams', 'probe-grep.grep.1.a1.jsonl')));
    const checked = checkResultsDir({ outDir: run.outDir, streamsOnly: true });
    assert.equal(checked.ok, true, JSON.stringify(checked.findings));
  });

  test('probe atlas arm adds the plugin, the settings, the Skill tool and the atlas tools', () => {
    const run = runProbe('atlas', [initEvent('atlas'), rateEvent(), reply('ok')]);
    assert.equal(run.code, 0, run.stderr);
    const report = JSON.parse(run.stdout.trim()) as Json;
    assert.equal(report['probe'], 'atlas');
    assert.deepEqual(report['signatureDiffs'], []);
    assert.equal(argAfter(run.argv, '--tools'), 'Bash,Read,Skill');
    assert.ok(run.argv.includes('--plugin-dir'));
    assert.equal(argAfter(run.argv, '--settings'), '{"disableBundledSkills":true,"skillOverrides":{"plugin-authoring":"off","design":"off","doctor":"off"}}');
    const allowed = argAfter(run.argv, '--allowedTools') ?? '';
    assert.ok(allowed.includes('Skill(gsd-atlas-eval:gsd-atlas)'));
    for (const tool of ATLAS_TOOL_NAMES) assert.ok(allowed.includes(tool), tool);
    assert.equal(path.basename(argAfter(run.argv, '--mcp-config') ?? ''), 'mcp.json');
  });

  test('probe names an init signature difference', () => {
    const odd = initEvent('grep');
    (odd['tools'] as string[]).push('WebFetch');
    const run = runProbe('grep', [odd, rateEvent(), reply('ok')]);
    assert.equal(run.code, 0, run.stderr);
    const report = JSON.parse(run.stdout.trim()) as { signatureDiffs: string[] };
    assert.ok(report.signatureDiffs.some((diff) => diff.includes('WebFetch')));
  });

  test('probe control-harness uses the grep arm isolation flags and prints the reply', () => {
    const run = runProbe('control-harness', [initEvent('grep'), rateEvent(), reply('none')]);
    assert.equal(run.code, 0, run.stderr);
    const report = JSON.parse(run.stdout.trim()) as Json;
    assert.equal(report['probe'], 'control-harness');
    assert.equal(report['reply'], 'none');
    assert.ok(run.stdin.includes('CLAUDE.md'));
    assert.ok(run.stdin.includes('otherwise reply with the single word none'));
    assert.equal(argAfter(run.argv, '--setting-sources'), '');
    assert.ok(run.argv.includes('--strict-mcp-config'));
    assert.equal(argAfter(run.argv, '--tools'), 'Bash,Read');
    assert.ok(fs.existsSync(path.join(run.outDir, 'streams', 'probe-control-harness.control.1.a1.jsonl')));
  });

  test('probe control-default runs without --setting-sources and prints at most 200 characters of the reply', () => {
    const run = runProbe('control-default', [initEvent('grep'), rateEvent(), reply('x'.repeat(300))]);
    assert.equal(run.code, 0, run.stderr);
    const report = JSON.parse(run.stdout.trim()) as { reply: string; probe: string };
    assert.equal(report.probe, 'control-default');
    assert.equal(report.reply.length, 200);
    assert.ok(!run.argv.includes('--setting-sources'));
    assert.ok(!run.argv.includes('--strict-mcp-config') && !run.argv.includes('--mcp-config'));
    assert.equal(argAfter(run.argv, '--tools'), '');
    assert.ok(run.argv.includes('--no-session-persistence'));
    assert.equal(argAfter(run.argv, '--model'), 'claude-sonnet-5-5');
    assert.equal(argAfter(run.argv, '--max-budget-usd'), '0.05');
  });

  test('probe refuses a bad arm and a missing corpus directory', () => {
    const noArm = runScript('probe.ts', ['--corpus-dir', os.tmpdir(), '--out-dir', path.join(tmpDir('probe-bad'), 'out')]);
    assert.equal(noArm.code, 2);
    const wrongArm = runScript('probe.ts', ['--arm', 'both', '--corpus-dir', os.tmpdir(), '--out-dir', path.join(tmpDir('probe-bad2'), 'out')]);
    assert.equal(wrongArm.code, 2);
    const noCorpus = runScript('probe.ts', ['--arm', 'grep', '--corpus-dir', path.join(tmpDir('probe-bad3'), 'missing'), '--out-dir', path.join(tmpDir('probe-bad4'), 'out')]);
    assert.equal(noCorpus.code, 2);
    assert.ok(!/\n\s+at /.test(noCorpus.stderr), 'no stack trace');
  });
});

// ---------------------------------------------------------------------------------------------
// shape of the tooling

describe('tooling imports', () => {
  test('the tools import only Node built-ins and the registered eval modules, never src', () => {
    const files = ['init-signature.ts', 'check-chunk.ts', 'compare.ts', 'scrub.ts', 'probe.ts'];
    for (const name of files) {
      const text = fs.readFileSync(SCRIPT(name), 'utf8');
      const specifiers = [...text.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+'([^']+)'/gm)].map((match) => match[1] as string);
      for (const specifier of specifiers) {
        const allowed = specifier.startsWith('node:') || /^\.\/[a-z-]+\.ts$/.test(specifier) || /^\.\.\/eval\/[a-z-]+\.ts$/.test(specifier);
        assert.ok(allowed, `${name} imports ${specifier}`);
        assert.ok(!specifier.includes('/src/'), `${name} imports src`);
      }
    }
  });

  test('the original mean wall time constant equals the committed original rows', { skip: !HAVE_ORIGINAL }, () => {
    const rows = loadOriginal();
    const mean = rows.reduce((total, row) => total + row.wallMs, 0) / rows.length;
    assert.ok(Math.abs(mean - ORIGINAL_MEAN_WALL_MS) < 0.01, `${String(mean)} against ${String(ORIGINAL_MEAN_WALL_MS)}`);
  });
});
