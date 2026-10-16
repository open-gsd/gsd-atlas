import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PROTOCOL_VERSION } from '../host-client/index.ts';
import type { Diagnostic, Envelope, HostClient, Request } from '../host-client/index.ts';
import { runCli } from './index.ts';

interface Harness {
  readonly requests: Request[];
  readonly stdout: string[];
  readonly stderr: string[];
  run(argv: readonly string[]): Promise<number>;
}

function harness(reply: Envelope | Error): Harness {
  const requests: Request[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const client: HostClient = {
    async handle(request: Request): Promise<Envelope> {
      requests.push(request);
      if (reply instanceof Error) {
        throw reply;
      }
      return reply;
    },
  };
  return {
    requests,
    stdout,
    stderr,
    run: (argv) =>
      runCli(argv, {
        client,
        version: () => '9.9.9',
        stdout: { write: (text) => stdout.push(text) },
        stderr: { write: (text) => stderr.push(text) },
      }),
  };
}

const d = (code: string, severity: Diagnostic['severity'], message: string): Diagnostic => ({ code, severity, message });
const okReply: Envelope = { schema: 'gsd-atlas.lang-test/1', ok: true, data: { ok: true }, diagnostics: [] };

describe('runCli lang test', () => {
  it('sends a lang_test request with the protocol version and the target, and prints one JSON line', async () => {
    const h = harness(okReply);
    const code = await h.run(['lang', 'test', 'some/folder']);
    assert.equal(code, 0);
    assert.deepEqual(h.requests, [{ protocol: PROTOCOL_VERSION, kind: 'lang_test', args: { target: 'some/folder' } }]);
    assert.equal(h.stdout.length, 1);
    assert.ok(h.stdout[0]!.endsWith('\n'));
    assert.deepEqual(JSON.parse(h.stdout[0]!), okReply);
    assert.deepEqual(h.stderr, []);
  });

  it('exits 2 for a failed run and prints one stderr line per error or warning diagnostic', async () => {
    const h = harness({
      schema: 'gsd-atlas.lang-test/1',
      ok: false,
      data: null,
      diagnostics: [d('golden_mismatch', 'error', 'emoji.toy: golden differs'), d('manifest_invalid', 'warning', 'name: bad'), d('note', 'info', 'quiet')],
    });
    const code = await h.run(['lang', 'test', 'x']);
    assert.equal(code, 2);
    assert.equal(h.stdout.length, 1);
    assert.deepEqual(h.stderr, [
      'gsd-atlas: error golden_mismatch: emoji.toy: golden differs\n',
      'gsd-atlas: warning manifest_invalid: name: bad\n',
    ]);
  });

  it('exits 1 when the envelope carries module_not_found', async () => {
    const h = harness({ schema: 'gsd-atlas.lang-test/1', ok: false, data: null, diagnostics: [d('module_not_found', 'error', 'nosuch: is not an existing module folder')] });
    assert.equal(await h.run(['lang', 'test', 'nosuch']), 1);
    assert.equal(h.stderr.length, 1);
  });

  it('exits 2 without a stack trace when the client throws', async () => {
    const h = harness(new Error('boom'));
    assert.equal(await h.run(['lang', 'test', 'x']), 2);
    assert.deepEqual(h.stdout, []);
    assert.deepEqual(h.stderr, ['gsd-atlas: error internal_error: boom\n']);
  });
});

describe('runCli usage', () => {
  it('prints the version for --version and -v', async () => {
    for (const flag of ['--version', '-v']) {
      const h = harness(okReply);
      assert.equal(await h.run([flag]), 0);
      assert.deepEqual(h.stdout, ['gsd-atlas 9.9.9\n']);
      assert.deepEqual(h.requests, []);
    }
  });

  it('prints usage on stdout for --help and -h', async () => {
    for (const flag of ['--help', '-h']) {
      const h = harness(okReply);
      assert.equal(await h.run([flag]), 0);
      assert.match(h.stdout.join(''), /Usage: gsd-atlas/);
      assert.match(h.stdout.join(''), /lang test <module-folder>/);
    }
  });

  it('exits 1, without contacting the host, for every usage error', async () => {
    const cases: string[][] = [
      [],
      ['unknown'],
      ['lang'],
      ['lang', 'list'],
      ['lang', 'test'],
      ['lang', 'test', 'a', 'b'],
      ['lang', 'test', 'a', '--json'],
      ['--nope'],
      ['-x'],
    ];
    for (const argv of cases) {
      const h = harness(okReply);
      assert.equal(await h.run(argv), 1, `argv ${JSON.stringify(argv)}`);
      assert.deepEqual(h.requests, [], `argv ${JSON.stringify(argv)} must not reach the host`);
      assert.deepEqual(h.stdout, []);
      assert.match(h.stderr.join(''), /^gsd-atlas: /);
    }
  });
});
