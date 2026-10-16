import assert from 'node:assert/strict';
import path from 'node:path';
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

describe('runCli lang list', () => {
  const listReply: Envelope = { schema: 'gsd-atlas.lang-list/1', ok: true, data: { modules: [] }, diagnostics: [] };

  it('sends a lang_list request with no roots when no flag is given, and prints one JSON line', async () => {
    const h = harness(listReply);
    assert.equal(await h.run(['lang', 'list']), 0);
    assert.deepEqual(h.requests, [{ protocol: PROTOCOL_VERSION, kind: 'lang_list', args: {} }]);
    assert.deepEqual(h.stdout.map((line) => JSON.parse(line)), [listReply]);
    assert.deepEqual(h.stderr, []);
  });

  it('exits 0 and prints a skipped module as a warning line on stderr', async () => {
    const h = harness({ ...listReply, diagnostics: [d('manifest_invalid', 'warning', '/x/toy: name: bad'), d('precise_command_inactive', 'info', 'quiet')] });
    assert.equal(await h.run(['lang', 'list']), 0);
    assert.deepEqual(h.stderr, ['gsd-atlas: warning manifest_invalid: /x/toy: name: bad\n']);
  });
});

describe('runCli root flags', () => {
  const okList: Envelope = { schema: 'gsd-atlas.lang-list/1', ok: true, data: { modules: [] }, diagnostics: [] };

  it('turns the four root flags into one absolute-path roots argument for lang list', async () => {
    const h = harness(okList);
    const argv = ['lang', 'list', '--repo-root', '/r', '--user-dir', '/u', '--builtin-dir', '/b', '--npm-root', '/n1', '--npm-root', '/n2'];
    assert.equal(await h.run(argv), 0);
    assert.deepEqual(h.requests[0]!.args, {
      roots: { repoRoot: path.resolve('/r'), userDir: path.resolve('/u'), builtinDir: path.resolve('/b'), npmRoots: [path.resolve('/n1'), path.resolve('/n2')] },
    });
  });

  it('sends the same roots with lang test, next to the target', async () => {
    const h = harness(okReply);
    assert.equal(await h.run(['lang', 'test', 'toy', '--repo-root', '/r']), 0);
    assert.deepEqual(h.requests[0]!.args, { target: 'toy', roots: { repoRoot: path.resolve('/r') } });
  });

  it('accepts the flags before the positionals and sends only the flags it was given', async () => {
    const h = harness(okReply);
    assert.equal(await h.run(['--user-dir', '/u', 'lang', 'test', 'toy']), 0);
    assert.deepEqual(h.requests[0]!.args, { target: 'toy', roots: { userDir: path.resolve('/u') } });
  });

  it('resolves a relative flag against the working directory before the host sees it', async () => {
    const h = harness(okList);
    assert.equal(await h.run(['lang', 'list', '--repo-root', 'some/dir']), 0);
    const roots = (h.requests[0]!.args as { roots: { repoRoot: string } }).roots;
    assert.equal(roots.repoRoot, path.resolve('some/dir'));
    assert.ok(path.isAbsolute(roots.repoRoot));
  });

  it('lists the root flags in the usage text', async () => {
    const h = harness(okList);
    await h.run(['--help']);
    for (const text of ['lang list', '--repo-root', '--user-dir', '--builtin-dir', '--npm-root']) {
      assert.ok(h.stdout.join('').includes(text), text);
    }
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
      ['lang', 'list', 'extra'],
      ['lang', 'test'],
      ['lang', 'test', 'a', '--repo-root'],
      ['lang', 'list', '--npm-root'],
      ['lang', 'list', '--bogus', 'x'],
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
