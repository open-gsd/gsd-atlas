/**
 * `gsd-atlas allow` (D-15, SEC-02): a terminal-only, two-step approval. The client is a recording fake, the terminal state
 * and the confirmation are injected, and the tests check what is sent, what is shown to the person and what is printed.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { PROTOCOL_VERSION } from '../host-client/index.ts';
import type { Diagnostic, Envelope, HostClient, Request } from '../host-client/index.ts';
import { makeTempDir } from '../test-kit/index.ts';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, runCli } from './index.ts';

const WORK = path.resolve('some', 'work');
const HASH = 'a'.repeat(64);
const SCHEMA = 'gsd-atlas.allow/1';

const PREVIEW = { repo: '/the/repo', executable: 'node', args: ['tools/x.js', '--flag'], cwd: '.', sha256: HASH };
const previewReply: Envelope = { schema: SCHEMA, ok: true, data: PREVIEW, diagnostics: [] };
const writtenReply: Envelope = { schema: SCHEMA, ok: true, data: { written: true, sha256: HASH, executable: 'node', args: ['tools/x.js', '--flag'] }, diagnostics: [] };
const failure = (code: string, message: string): Envelope => ({
  schema: 'gsd-atlas.error/1',
  ok: false,
  data: null,
  diagnostics: [{ code, severity: 'error', message } satisfies Diagnostic],
});

interface Options {
  readonly replies: readonly Envelope[];
  readonly isTTY: boolean;
  readonly answers?: readonly string[];
}

interface Harness {
  readonly requests: Request[];
  readonly stdout: string[];
  readonly stderr: string[];
  /** What had been written to stderr when each question was asked, and the question. */
  readonly asked: Array<{ readonly question: string; readonly stderrBefore: string }>;
  run(argv: readonly string[]): Promise<number>;
}

function harness(options: Options): Harness {
  const requests: Request[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const asked: Harness['asked'] = [];
  const replies = [...options.replies];
  const answers = [...(options.answers ?? [])];
  const client: HostClient = {
    handle(request: Request): Promise<Envelope> {
      requests.push(request);
      const next = replies.shift();
      return next === undefined ? Promise.reject(new Error('no scripted reply left')) : Promise.resolve(next);
    },
  };
  return {
    requests,
    stdout,
    stderr,
    asked,
    run: (argv) =>
      runCli(argv, {
        client,
        version: () => '9.9.9',
        stdout: { write: (text) => stdout.push(text) },
        stderr: { write: (text) => stderr.push(text) },
        cwd: WORK,
        isTTY: options.isTTY,
        prompt: (question) => {
          asked.push({ question, stderrBefore: stderr.join('') });
          return Promise.resolve(answers.shift() ?? '');
        },
      }),
  };
}

const terminal = (replies: readonly Envelope[], answers: readonly string[]): Harness => harness({ replies, isTTY: true, answers });

describe('gsd-atlas allow: preview then write', () => {
  it('preview then write: shows the exact command, asks, sends the hash back and prints one envelope', async () => {
    const h = terminal([previewReply, writtenReply], ['y']);
    const code = await h.run(['allow', '--', 'node', 'tools/x.js', '--flag']);
    assert.equal(code, EXIT_OK);
    assert.equal(h.requests.length, 2);
    const argv = ['node', 'tools/x.js', '--flag'];
    assert.deepEqual(h.requests[0], { protocol: PROTOCOL_VERSION, kind: 'allow', args: { argv } });
    assert.deepEqual(h.requests[1], { protocol: PROTOCOL_VERSION, kind: 'allow', args: { argv, confirm: HASH } });
    // One JSON envelope on stdout: the confirmed reply, exactly as returned.
    assert.equal(h.stdout.length, 1);
    assert.ok(h.stdout[0]?.endsWith('\n'));
    assert.deepEqual(JSON.parse(h.stdout[0] as string), writtenReply);
    // The person saw the repository, executable, arguments, working directory and hash BEFORE being asked.
    assert.equal(h.asked.length, 1);
    const shown = h.asked[0]?.stderrBefore ?? '';
    for (const part of ['/the/repo', 'node', '"tools/x.js"', '"--flag"', 'working directory', '.', HASH]) {
      assert.ok(shown.includes(part), `the preview shows ${part}`);
    }
  });

  it('approved argv: the confirmed output shows what was approved, quoted and escaped, on stderr only', async () => {
    const hostile: Envelope = { ...writtenReply, data: { written: true, sha256: HASH, executable: 'node', args: ['a\u001b[2Jb', 'two words'] } };
    const h = terminal([previewReply, hostile], ['y']);
    assert.equal(await h.run(['allow', '--', 'node', 'x']), EXIT_OK);
    const text = h.stderr.join('');
    assert.ok(text.includes('approved command:'), 'the approved command is named');
    assert.ok(text.includes('"node"') && text.includes('"two words"'), 'executable and arguments are shown quoted');
    assert.ok(!text.includes('\u001b'), 'no raw ESC reaches the terminal');
    assert.ok(text.includes('\\u001b[2J'), 'the control character is shown escaped');
  });

  it('approved argv: an error reply, or a reply without the fields, prints no approved command line', async () => {
    const refused = terminal([previewReply, failure('confirm_mismatch', 'nope')], ['y']);
    await refused.run(['allow', '--', 'node', 'x']);
    assert.ok(!refused.stderr.join('').includes('approved command:'));
    const bare = terminal([previewReply, { ...writtenReply, data: { written: true, sha256: HASH } }], ['y']);
    assert.equal(await bare.run(['allow', '--', 'node', 'x']), EXIT_OK);
    assert.ok(!bare.stderr.join('').includes('approved command:'));
  });

  it('keeps flags after the double dash as arguments of the command, not as flags of allow', async () => {
    const h = terminal([previewReply, writtenReply], ['yes']);
    const code = await h.run(['allow', '--repo', 'r', '--', 'node', '--version', '-v', '--repo', 'x']);
    assert.equal(code, EXIT_OK);
    assert.deepEqual(h.requests[0]?.args, { repo: path.resolve(WORK, 'r'), argv: ['node', '--version', '-v', '--repo', 'x'] });
  });

  it('restart note: the output says a running MCP server must be restarted to see the approval', async () => {
    const h = terminal([previewReply, writtenReply], ['y']);
    await h.run(['allow', '--', 'node', 'tools/x.js']);
    const text = h.stderr.join('');
    assert.match(text, /running MCP server/);
    assert.match(text, /restart/i);
    assert.doesNotMatch(h.stdout.join(''), /restart/, 'the note is for the person, stdout stays one JSON envelope');
  });

  it('shows control characters of an argument escaped, so a manifest or a paste cannot repaint the terminal', async () => {
    const hostile = { ...PREVIEW, args: ['\u001b[2J\u001b[1;1Hlooks safe', 'a\nb', ' '] };
    const h = terminal([{ ...previewReply, data: hostile }, writtenReply], ['n']);
    await h.run(['allow', '--', 'node', 'x']);
    const text = h.stderr.join('');
    assert.ok(!text.includes('\u001b'), 'no raw ESC reaches the terminal');
    assert.ok(!text.includes(' '));
    assert.match(text, /\\u001b\[2J/);
  });
});

describe('gsd-atlas allow: declined', () => {
  it('declined: n writes nothing, sends only the preview request and exits 1', async () => {
    const h = terminal([previewReply, writtenReply], ['n']);
    assert.equal(await h.run(['allow', '--', 'node', 'tools/x.js']), EXIT_USAGE);
    assert.equal(h.requests.length, 1);
    assert.equal((h.requests[0]?.args as { confirm?: string }).confirm, undefined);
    assert.deepEqual(h.stdout, []);
    assert.match(h.stderr.join(''), /nothing was approved/);
  });

  it('declined: an empty line, or anything but y or yes, is a no', async () => {
    for (const answer of ['', '  ', 'maybe', 'nope', 'yy']) {
      const h = terminal([previewReply, writtenReply], [answer]);
      assert.equal(await h.run(['allow', '--', 'node', 'x']), EXIT_USAGE, JSON.stringify(answer));
      assert.equal(h.requests.length, 1, JSON.stringify(answer));
    }
  });

  it('accepts y and yes in any case, with surrounding space', async () => {
    for (const answer of ['y', 'Y', ' yes ', 'YES']) {
      const h = terminal([previewReply, writtenReply], [answer]);
      assert.equal(await h.run(['allow', '--', 'node', 'x']), EXIT_OK, JSON.stringify(answer));
      assert.equal(h.requests.length, 2, JSON.stringify(answer));
    }
  });
});

describe('gsd-atlas allow: no terminal', () => {
  it('no terminal: says allow needs a terminal, sends nothing, writes nothing and exits 2', async () => {
    const tmp = makeTempDir();
    try {
      const userConfig = path.join(tmp.path, 'config.json');
      const h = harness({ replies: [previewReply, writtenReply], isTTY: false, answers: ['y'] });
      assert.equal(await h.run(['allow', '--', 'node', 'tools/x.js']), EXIT_FAILURE);
      assert.deepEqual(h.requests, []);
      assert.deepEqual(h.asked, [], 'a non-terminal run never prompts');
      assert.deepEqual(h.stdout, []);
      assert.match(h.stderr.join(''), /allow needs a terminal/);
      assert.equal(fs.existsSync(userConfig), false);
    } finally {
      tmp.cleanup();
    }
  });

  it('a client that did not say it has a terminal is treated as having none', async () => {
    const requests: Request[] = [];
    const stderr: string[] = [];
    const code = await runCli(['allow', '--', 'node', 'x'], {
      client: {
        handle(request) {
          requests.push(request);
          return Promise.resolve(previewReply);
        },
      },
      version: () => '9.9.9',
      stdout: { write: () => true },
      stderr: { write: (text) => stderr.push(text) },
      cwd: WORK,
    });
    assert.equal(code, EXIT_FAILURE);
    assert.deepEqual(requests, []);
    assert.match(stderr.join(''), /allow needs a terminal/);
  });
});

describe('gsd-atlas allow: usage line', () => {
  it('usage line: --help lists allow with its double dash form', async () => {
    const h = terminal([], []);
    assert.equal(await h.run(['--help']), EXIT_OK);
    assert.match(h.stdout.join(''), /gsd-atlas allow .*-- <executable> <args\.\.\.>/);
  });

  it('usage line: a missing command, or arguments before the double dash, is a usage error that sends nothing', async () => {
    for (const argv of [['allow'], ['allow', 'node', 'x.js'], ['allow', '--'], ['allow', 'stray', '--', 'node']]) {
      const h = terminal([previewReply], ['y']);
      assert.equal(await h.run(argv), EXIT_USAGE, argv.join(' '));
      assert.deepEqual(h.requests, [], argv.join(' '));
      assert.match(h.stderr.join(''), /Usage: gsd-atlas/, argv.join(' '));
    }
  });

  it('usage line: flags that do not apply to allow are refused', async () => {
    const h = terminal([], []);
    assert.equal(await h.run(['allow', '--budget', '5', '--', 'node']), EXIT_USAGE);
    assert.match(h.stderr.join(''), /--budget does not apply to allow/);
  });
});

describe('gsd-atlas allow: --workdir and --module', () => {
  it('workdir: a relative working directory is passed through unchanged in both requests', async () => {
    const h = terminal([previewReply, writtenReply], ['y']);
    assert.equal(await h.run(['allow', '--workdir', 'sub/dir', '--', 'node', 'x.js']), EXIT_OK);
    assert.deepEqual(h.requests[0]?.args, { workdir: 'sub/dir', argv: ['node', 'x.js'] });
    assert.deepEqual(h.requests[1]?.args, { workdir: 'sub/dir', argv: ['node', 'x.js'], confirm: HASH });
  });

  it('module: --module sends the module name and no argv, shows what the Host proposes, and writes only after yes', async () => {
    const proposed = { ...PREVIEW, executable: 'node', args: ['evil.js', 'SECRET-MARKER'], fromModule: true };
    const h = terminal([{ ...previewReply, data: proposed }, writtenReply], ['y']);
    assert.equal(await h.run(['allow', '--repo', 'r', '--module', 'typescript-evil']), EXIT_OK);
    assert.deepEqual(h.requests[0]?.args, { repo: path.resolve(WORK, 'r'), module: 'typescript-evil' });
    assert.deepEqual(h.requests[1]?.args, { repo: path.resolve(WORK, 'r'), module: 'typescript-evil', confirm: HASH });
    // The manifest text is on the terminal for the person ...
    assert.ok((h.asked[0]?.stderrBefore ?? '').includes('SECRET-MARKER'));
    assert.match(h.asked[0]?.stderrBefore ?? '', /module manifest/);
    // ... and nowhere in what the command prints as its result.
    assert.ok(!h.stdout.join('').includes('SECRET-MARKER'));
  });

  it('module: declined means nothing is written', async () => {
    const h = terminal([{ ...previewReply, data: { ...PREVIEW, fromModule: true } }, writtenReply], ['n']);
    assert.equal(await h.run(['allow', '--module', 'typescript-evil']), EXIT_USAGE);
    assert.equal(h.requests.length, 1);
  });

  it('module: --module together with a command after the double dash, or with an empty name, is a usage error', async () => {
    for (const argv of [['allow', '--module', 'm', '--', 'node'], ['allow', '--module', '']]) {
      const h = terminal([previewReply], ['y']);
      assert.equal(await h.run(argv), EXIT_USAGE, argv.join(' '));
      assert.deepEqual(h.requests, [], argv.join(' '));
    }
  });

  it('usage line: the usage text lists --workdir and --module', async () => {
    const h = terminal([], []);
    await h.run(['--help']);
    assert.match(h.stdout.join(''), /gsd-atlas allow .*--workdir <dir>.*--module <name>/);
  });
});

describe('gsd-atlas allow: failures', () => {
  it('a failed preview prints its envelope, shows no prompt and exits with the usual code', async () => {
    const reply = failure('not_a_repo', 'repo must be an existing directory inside a git repository.');
    const h = terminal([reply], ['y']);
    assert.equal(await h.run(['allow', '--', 'node', 'x']), EXIT_FAILURE);
    assert.deepEqual(h.asked, []);
    assert.deepEqual(JSON.parse(h.stdout[0] as string), reply);
    assert.match(h.stderr.join(''), /error not_a_repo/);
  });

  it('a confirm mismatch from the Host prints its envelope and exits 2', async () => {
    const reply = failure('confirm_mismatch', 'The confirmation does not match this command, so nothing was written. Run the preview again.');
    const h = terminal([previewReply, reply], ['y']);
    assert.equal(await h.run(['allow', '--', 'node', 'x']), EXIT_FAILURE);
    assert.equal(h.requests.length, 2);
    assert.deepEqual(JSON.parse(h.stdout[0] as string), reply);
  });

  it('invalid config: an unusable user configuration file is reported in its fixed sentence and exits 3', async () => {
    const message = 'the user configuration file is invalid and was not changed: it is not valid JSON';
    const reply = failure('config_invalid', message);
    // The dry run refuses (nothing is asked) ...
    const early = terminal([reply], ['y']);
    assert.equal(await early.run(['allow', '--', 'node', 'x']), 3);
    assert.deepEqual(early.asked, []);
    assert.ok(early.stderr.join('').includes(message));
    // ... and so does a write that finds the file broken after the question (the file changed in between).
    const late = terminal([previewReply, reply], ['y']);
    assert.equal(await late.run(['allow', '--', 'node', 'x']), 3);
    assert.ok(late.stderr.join('').includes(message));
    assert.deepEqual(JSON.parse(late.stdout[0] as string), reply);
  });

  it('a config too large or a write failure is an ordinary failure, exit 2', async () => {
    for (const code of ['config_too_large', 'write_failed', 'config_changed']) {
      const h = terminal([previewReply, failure(code, 'fixed text')], ['y']);
      assert.equal(await h.run(['allow', '--', 'node', 'x']), EXIT_FAILURE, code);
    }
  });

  it('already approved: says so instead of the restart note and exits 0', async () => {
    const already: Envelope = { schema: SCHEMA, ok: true, data: { written: false, sha256: HASH, already_allowed: true }, diagnostics: [] };
    const h = terminal([previewReply, already], ['y']);
    assert.equal(await h.run(['allow', '--', 'node', 'x']), EXIT_OK);
    assert.match(h.stderr.join(''), /already approved/);
    assert.doesNotMatch(h.stderr.join(''), /restarted/);
  });

  it('refuses a preview reply it cannot read instead of asking about something unseen', async () => {
    const h = terminal([{ schema: SCHEMA, ok: true, data: { repo: 3 }, diagnostics: [] }, writtenReply], ['y']);
    assert.equal(await h.run(['allow', '--', 'node', 'x']), EXIT_FAILURE);
    assert.deepEqual(h.asked, []);
    assert.equal(h.requests.length, 1);
  });
});
