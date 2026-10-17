import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import { PROTOCOL_VERSION, buildRequest } from '../host-client/index.ts';
import type { Diagnostic, Envelope, HostClient, Request } from '../host-client/index.ts';
import { EXIT_FAILURE, EXIT_LEASE_HELD, EXIT_OK, EXIT_USAGE, runCli } from './index.ts';

interface Harness {
  readonly requests: Request[];
  readonly stdout: string[];
  readonly stderr: string[];
  run(argv: readonly string[]): Promise<number>;
}

/** The working directory the harness gives the CLI; relative flags resolve against it. */
const WORK = path.resolve('some', 'work');

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
        cwd: WORK,
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

describe('runCli exit codes', () => {
  it('exports the four exit codes', () => {
    assert.deepEqual([EXIT_OK, EXIT_USAGE, EXIT_FAILURE, EXIT_LEASE_HELD], [0, 1, 2, 3]);
  });
});

describe('runCli find', () => {
  const findReply: Envelope = { schema: 'gsd-atlas.code-find/1', ok: true, data: { results: [] }, diagnostics: [] };
  const repo = path.resolve('a', 'repository');

  it('sends exactly the request the MCP adapter builds for code_find, with cwd unset when --repo is given, and prints one JSON line', async () => {
    const h = harness(findReply);
    assert.equal(await h.run(['find', 'helper', '--repo', repo]), 0);
    assert.deepEqual(h.requests, [buildRequest('code_find', { name: 'helper', repo })]);
    assert.equal(h.requests[0]?.worktree, repo);
    assert.equal(h.stdout.length, 1);
    assert.ok(h.stdout[0]!.endsWith('\n'));
    assert.equal(h.stdout[0]!.indexOf('\n'), h.stdout[0]!.length - 1, 'one line');
    assert.deepEqual(JSON.parse(h.stdout[0]!), findReply);
    assert.deepEqual(h.stderr, []);
  });

  it('maps --budget, --more, --fresh (repeatable), --limit, --kind and --mode onto the schema fields', async () => {
    const h = harness(findReply);
    const argv = ['find', 'helper', '--repo', repo, '--budget', '500', '--more', 'cursor-1', '--fresh', 'a.ts', '--fresh', 'b/c.ts', '--limit', '7', '--kind', 'function', '--mode', 'prefix'];
    assert.equal(await h.run(argv), 0);
    assert.deepEqual(
      h.requests,
      [buildRequest('code_find', { name: 'helper', repo, budget_tokens: 500, more: 'cursor-1', fresh: ['a.ts', 'b/c.ts'], limit: 7, kind: 'function', mode: 'prefix' })],
    );
    assert.equal(h.requests[0]?.budget_tokens, 500);
    assert.deepEqual(h.requests[0]?.fresh, ['a.ts', 'b/c.ts']);
  });

  it('resolves a relative --repo and --cwd against the working directory before the host sees them', async () => {
    const h = harness(findReply);
    assert.equal(await h.run(['find', 'x', '--repo', 'r', '--cwd', path.join('r', 'sub')]), 0);
    assert.deepEqual(h.requests, [buildRequest('code_find', { name: 'x', repo: path.join(WORK, 'r'), cwd: path.join(WORK, 'r', 'sub') })]);
  });

  it('sends no repo at all when neither --repo nor --cwd is given (the host uses its own working directory)', async () => {
    const h = harness(findReply);
    assert.equal(await h.run(['find', 'x']), 0);
    assert.deepEqual(h.requests, [buildRequest('code_find', { name: 'x' })]);
    assert.equal(h.requests[0]?.worktree, undefined);
  });

  it('exits 2 with the reason line on stderr and the envelope unchanged on stdout for not_indexed', async () => {
    const reply: Envelope = {
      schema: 'gsd-atlas.error/1',
      ok: false,
      data: null,
      diagnostics: [d('not_indexed', 'error', 'This repository has not been indexed yet. Run "gsd-atlas build" in it, then ask again.')],
    };
    const h = harness(reply);
    assert.equal(await h.run(['find', 'x']), 2);
    assert.deepEqual(h.stdout.map((line) => JSON.parse(line)), [reply]);
    assert.equal(h.stderr.length, 1);
    assert.match(h.stderr[0]!, /gsd-atlas build/);
  });

  it('exits 1 with the usage text on stderr and nothing on stdout for every bad find invocation', async () => {
    const cases: string[][] = [
      ['find'],
      ['find', 'a', 'b'],
      ['find', 'x', '--bogus'],
      ['find', 'x', '--depth', '2'],
      ['find', 'x', '--limit', 'abc'],
      ['find', 'x', '--limit', '1.5'],
      ['find', 'x', '--limit', '0'],
      ['find', 'x', '--budget', 'lots'],
      ['find', 'x', '--mode', 'wild'],
      ['find', ''],
      ['find', 'x', '--repo'],
      ['find', 'x', '--agent', 'claude'],
    ];
    for (const argv of cases) {
      const h = harness(findReply);
      assert.equal(await h.run(argv), 1, `argv ${JSON.stringify(argv)}`);
      assert.deepEqual(h.requests, [], `argv ${JSON.stringify(argv)} must not reach the host`);
      assert.deepEqual(h.stdout, [], `argv ${JSON.stringify(argv)}`);
      assert.match(h.stderr.join(''), /^gsd-atlas: [^\n]*\nUsage: gsd-atlas/, `argv ${JSON.stringify(argv)}`);
    }
  });

  it('lists find and the other new commands in the usage text', async () => {
    const h = harness(findReply);
    await h.run(['--help']);
    const text = h.stdout.join('');
    for (const word of ['find', 'build', '--repo', '--cwd', '--budget', '--fresh']) {
      assert.ok(text.includes(word), word);
    }
  });
});

describe('runCli build', () => {
  const buildReply: Envelope = { schema: 'gsd-atlas.build/1', ok: true, data: { files: 3 }, diagnostics: [] };

  it('sends a build request with the repository and prints one JSON line', async () => {
    const h = harness(buildReply);
    assert.equal(await h.run(['build', '--repo', 'r']), 0);
    assert.deepEqual(h.requests, [{ protocol: PROTOCOL_VERSION, kind: 'build', args: { repo: path.join(WORK, 'r') } }]);
    assert.deepEqual(h.stdout.map((line) => JSON.parse(line)), [buildReply]);
  });

  it('sends empty arguments without a flag, and refuses a positional and a flag it does not use', async () => {
    const h = harness(buildReply);
    assert.equal(await h.run(['build']), 0);
    assert.deepEqual(h.requests, [{ protocol: PROTOCOL_VERSION, kind: 'build', args: {} }]);
    for (const argv of [['build', 'x'], ['build', '--limit', '1'], ['build', '--full']]) {
      const refused = harness(buildReply);
      assert.equal(await refused.run(argv), 1, `argv ${JSON.stringify(argv)}`);
      assert.deepEqual(refused.requests, []);
    }
  });
});

describe('runCli busy and lease_held', () => {
  it('a busy reply is printed unchanged, its stderr line carries busy and retry_after, and the exit code is 3', async () => {
    const reply: Envelope = {
      schema: 'gsd-atlas.error/1',
      ok: false,
      data: null,
      diagnostics: [d('busy', 'error', 'The host is busy. Try again soon.')],
      retry_after: 250,
    };
    const h = harness(reply);
    assert.equal(await h.run(['find', 'x']), 3);
    assert.deepEqual(h.stdout.map((line) => JSON.parse(line)), [reply]);
    assert.equal(h.stderr.length, 1);
    assert.match(h.stderr[0]!, /busy/);
    assert.match(h.stderr[0]!, /250/);
  });

  it('a lease_held reply from build exits 3 with one reason line and the envelope on stdout', async () => {
    const reply: Envelope = {
      schema: 'gsd-atlas.error/1',
      ok: false,
      data: null,
      diagnostics: [d('lease_held', 'error', 'Another gsd-atlas process holds the writer for this repository.')],
    };
    const h = harness(reply);
    assert.equal(await h.run(['build']), 3);
    assert.deepEqual(h.stdout.map((line) => JSON.parse(line)), [reply]);
    assert.deepEqual(h.stderr, ['gsd-atlas: error lease_held: Another gsd-atlas process holds the writer for this repository.\n']);
  });

  it('a diagnostic message with a line break stays one stderr line', async () => {
    const h = harness({ schema: 'gsd-atlas.error/1', ok: false, data: null, diagnostics: [d('not_indexed', 'error', 'first\nsecond\r\nthird')] });
    assert.equal(await h.run(['find', 'x']), 2);
    assert.equal(h.stderr.length, 1);
    assert.equal(h.stderr[0]!.split('\n').length, 2, 'one line plus the trailing newline');
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
