import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PRECISE_LIMITS, PROTOCOL_VERSION, encodeRequest, encodeResponse, parseRequest, parseResponse } from './protocol.ts';
import type { Request, Response } from './protocol.ts';

const SITE = { path: 'src/user.cts', row: 4, col: 12, name: 'compute' };
const TARGET = { path: 'src/lib.cts', row: 0, col: 16, name: 'compute', kind: 'FunctionDeclaration' };

const REQUESTS: readonly Request[] = [
  { t: 'init', protocol: 1, worktreeRoot: '/work/repo', compilerDir: null, bundledDir: '/pkg/typescript', configs: ['tsconfig.json'], heapMb: 2048 },
  { t: 'init', protocol: 1, worktreeRoot: '/work/repo', compilerDir: '/work/repo/node_modules/typescript', bundledDir: '/pkg/typescript', configs: [], heapMb: 512 },
  { t: 'resolve', id: 7, config: 'tsconfig.json', sites: [SITE, { ...SITE, row: 9 }] },
  { t: 'resolve', id: 0, config: 'packages/a/tsconfig.json', sites: [] },
  { t: 'update', id: 4, changed: ['src/lib.cts', 'src/new.cts'], removed: ['src/old.cts'] },
  { t: 'update', id: 5, changed: [], removed: [] },
  { t: 'ping', id: 3 },
];

const RESPONSES: readonly Response[] = [
  { t: 'ready', compiler: { version: '6.0.3', source: 'bundled' }, rssMb: 91.5 },
  { t: 'ready', compiler: { version: '6.0.2', source: 'project' }, rssMb: 0 },
  { t: 'edge', id: 7, site: SITE, targets: [TARGET] },
  { t: 'edge', id: 7, site: SITE, targets: [] },
  { t: 'done', id: 7, asked: 2, answered: 1 },
  { t: 'done', id: 8, asked: 0, answered: 0, programs: 1, rssMb: 120.5, reads: 1 },
  { t: 'error', id: 7, code: 'bad_site', message: 'a site was refused' },
  { t: 'error', id: null, code: 'init_failed', message: 'the compiler could not be loaded' },
];

describe('worker protocol', () => {
  it('every request round-trips through its schema', () => {
    for (const message of REQUESTS) {
      const line = encodeRequest(message);
      assert.ok(line.endsWith('\n') && line.indexOf('\n') === line.length - 1, 'one line per message');
      const parsed = parseRequest(line.trimEnd());
      assert.ok(parsed.ok);
      assert.deepEqual(parsed.value, message);
    }
  });

  it('every response round-trips through its schema', () => {
    for (const message of RESPONSES) {
      const line = encodeResponse(message);
      assert.ok(line.endsWith('\n') && line.indexOf('\n') === line.length - 1, 'one line per message');
      const parsed = parseResponse(line.trimEnd());
      assert.ok(parsed.ok);
      assert.deepEqual(parsed.value, message);
    }
  });

  it('the protocol number is 1 and no other is accepted', () => {
    assert.equal(PROTOCOL_VERSION, 1);
    const wrong = JSON.stringify({ ...REQUESTS[0], protocol: 2 });
    assert.equal(parseRequest(wrong).ok, false);
  });

  it('unknown properties are rejected, on a message and on a site', () => {
    assert.equal(parseRequest(JSON.stringify({ t: 'ping', id: 1, extra: true })).ok, false);
    assert.equal(parseRequest(JSON.stringify({ t: 'resolve', id: 1, config: 'tsconfig.json', sites: [{ ...SITE, span: 1 }] })).ok, false);
    assert.equal(parseResponse(JSON.stringify({ t: 'done', id: 1, asked: 0, answered: 0, note: 'x' })).ok, false);
  });

  it('a negative row, a negative column and a fractional position are rejected', () => {
    for (const bad of [{ ...SITE, row: -1 }, { ...SITE, col: -2 }, { ...SITE, row: 1.5 }]) {
      assert.equal(parseRequest(JSON.stringify({ t: 'resolve', id: 1, config: 'tsconfig.json', sites: [bad] })).ok, false);
    }
  });

  it('a missing id is rejected', () => {
    assert.equal(parseRequest(JSON.stringify({ t: 'ping' })).ok, false);
    assert.equal(parseRequest(JSON.stringify({ t: 'resolve', config: 'tsconfig.json', sites: [] })).ok, false);
    assert.equal(parseResponse(JSON.stringify({ t: 'done', asked: 0, answered: 0 })).ok, false);
  });

  it('an unknown message type and text that is not JSON are rejected', () => {
    assert.equal(parseRequest(JSON.stringify({ t: 'shutdown' })).ok, false);
    assert.equal(parseResponse('not json').ok, false);
    assert.equal(parseResponse('').ok, false);
    assert.equal(parseResponse('[]').ok, false);
  });

  it('a line longer than the configured limit is rejected without being parsed', () => {
    const line = JSON.stringify({ t: 'ping', id: 1 });
    assert.equal(parseRequest(line, line.length).ok, true);
    const refused = parseRequest(line, line.length - 1);
    assert.equal(refused.ok, false);
    const long = JSON.stringify({ t: 'error', id: 1, code: 'x', message: 'y'.repeat(100) });
    assert.equal(parseResponse(long, 50).ok, false);
    assert.equal(PRECISE_LIMITS.maxLineBytes, 4_194_304);
    assert.equal(PRECISE_LIMITS.sitesPerRequest, 2000);
  });

  it('more sites than one request may carry are rejected', () => {
    const sites = Array.from({ length: PRECISE_LIMITS.sitesPerRequest + 1 }, (_, i) => ({ ...SITE, row: i }));
    assert.equal(parseRequest(JSON.stringify({ t: 'resolve', id: 1, config: 'tsconfig.json', sites })).ok, false);
  });

  it('an update carries at most one request of paths in each list, no empty path and nothing else', () => {
    const many = Array.from({ length: PRECISE_LIMITS.sitesPerRequest + 1 }, (_, i) => `src/f${String(i)}.cts`);
    assert.equal(parseRequest(JSON.stringify({ t: 'update', id: 1, changed: many.slice(0, PRECISE_LIMITS.sitesPerRequest), removed: [] })).ok, true);
    assert.equal(parseRequest(JSON.stringify({ t: 'update', id: 1, changed: many, removed: [] })).ok, false);
    assert.equal(parseRequest(JSON.stringify({ t: 'update', id: 1, changed: [], removed: many })).ok, false);
    assert.equal(parseRequest(JSON.stringify({ t: 'update', id: 1, changed: [''], removed: [] })).ok, false);
    assert.equal(parseRequest(JSON.stringify({ t: 'update', id: 1, changed: [], removed: [], extra: 1 })).ok, false);
    assert.equal(parseRequest(JSON.stringify({ t: 'update', changed: [], removed: [] })).ok, false);
    assert.equal(parseRequest(JSON.stringify({ t: 'update', id: 1, changed: ['a'] })).ok, false);
  });

  it('a refusal names the field and the problem and quotes no file text', () => {
    const secret = 'TOP-SECRET-FILE-TEXT';
    const cases = [
      JSON.stringify({ t: 'ping', id: 1, [secret]: secret }),
      JSON.stringify({ t: 'resolve', id: 1, config: secret, sites: [{ ...SITE, row: secret }] }),
      JSON.stringify({ t: secret }),
      `${secret} is not json`,
      JSON.stringify({ t: 'edge', id: 1, site: { ...SITE, name: 5 }, targets: [{ ...TARGET, kind: secret, extra: secret }] }),
    ];
    for (const line of cases) {
      const request = parseRequest(line);
      const response = parseResponse(line);
      for (const refused of [request, response]) {
        assert.equal(refused.ok, false);
        if (!refused.ok) assert.equal(refused.message.includes(secret), false, refused.message);
      }
    }
  });
});
