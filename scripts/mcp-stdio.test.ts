/**
 * The stdio MCP server as a real process (HST-01, QRY-06): `src/bin/gsd-atlas-mcp.ts` started through the
 * CommandRunner with a controllable stdin, over a real index built by the real Host in a temporary git repository.
 * Every stdout line the server prints is parsed as JSON; a stray write would fail the framing assertions.
 *
 * It lives under scripts because it composes the whole stack, which the adapter lint forbids inside src/mcp-shim.
 * Latencies are never asserted to the millisecond: the ceilings below only turn a hung child into a failed test.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';

import { composeHost } from '../src/bin/compose.ts';
import { allowAll, createRealRunner } from '../src/command-runner/index.ts';
import type { CommandResult, CommandStream } from '../src/command-runner/index.ts';
import { PROTOCOL_VERSION, TOOL_NAMES } from '../src/host-client/index.ts';
import { createTempGitRepo, makeTempDir } from '../src/test-kit/index.ts';
import type { TempDir, TempGitRepo } from '../src/test-kit/index.ts';
import { lineReader, within } from './test-helpers/child-lines.ts';

const BIN = path.resolve(import.meta.dirname, '..', 'src', 'bin', 'gsd-atlas-mcp.ts');
const runner = createRealRunner({ decide: allowAll });

/** Ceilings only: a hung child fails the test instead of the run. They are not performance assertions. */
const REPLY_CEILING_MS = 90_000;
const EXIT_CEILING_MS = 60_000;

const FILES: Readonly<Record<string, string>> = {
  'a.ts': 'export function load(): number {\n  return 1;\n}\n',
  'b.ts': "import { load } from './a';\nexport function run(): number {\n  return load();\n}\n",
  'c.ts': "import { run } from './b';\nexport function main(): number {\n  return run();\n}\n",
};

/** An async queue of stdin chunks: the child's stdin stays open until `end()`. */
class StdinQueue implements AsyncIterable<string> {
  private readonly items: string[] = [];
  private waiting: ((result: IteratorResult<string>) => void) | undefined;
  private ended = false;

  push(text: string): void {
    const waiting = this.waiting;
    if (waiting === undefined) {
      this.items.push(text);
      return;
    }
    this.waiting = undefined;
    waiting({ value: text, done: false });
  }

  end(): void {
    this.ended = true;
    const waiting = this.waiting;
    this.waiting = undefined;
    waiting?.({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<string> {
    return {
      next: (): Promise<IteratorResult<string>> => {
        const item = this.items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this.waiting = resolve;
        });
      },
    };
  }
}

export interface RpcMessage {
  readonly jsonrpc?: unknown;
  readonly id?: number;
  readonly method?: string;
  readonly result?: Record<string, unknown>;
  readonly error?: { readonly code: number; readonly message: string };
  readonly [key: string]: unknown;
}

export interface Envelope {
  readonly schema: string;
  readonly ok: boolean;
  readonly data: unknown;
  readonly diagnostics: ReadonlyArray<{ readonly code: string; readonly severity: string; readonly message: string }>;
  readonly degraded?: readonly string[];
  readonly [key: string]: unknown;
}

interface ToolResult {
  readonly content: ReadonlyArray<{ readonly type: string; readonly text: string }>;
  readonly isError?: boolean;
}

export interface ToolCall {
  readonly reply: RpcMessage;
  readonly result: ToolResult;
  readonly envelope: Envelope;
}

/** A test-side JSON-RPC client over the server's stdin and stdout. */
export class McpProcess {
  readonly stdin = new StdinQueue();
  /** Every stdout line, in order, exactly as printed (without the newline). */
  readonly lines: string[] = [];
  readonly messages: RpcMessage[] = [];
  private nextId = 1;
  private readonly waiters = new Map<number, (message: RpcMessage) => void>();
  private readonly stream: CommandStream;
  private readonly pumped: Promise<void>;
  private ended: Promise<CommandResult> | undefined;

  constructor(cwd: string, env: Readonly<Record<string, string>>) {
    this.stream = runner.stream({ executable: process.execPath, args: [BIN], cwd, env, stdin: this.stdin });
    const reader = lineReader(this.stream.stdout);
    this.pumped = (async () => {
      for (;;) {
        const line = await reader.next();
        if (line === undefined) return;
        this.lines.push(line);
        let message: RpcMessage | undefined;
        try {
          message = JSON.parse(line) as RpcMessage;
        } catch {
          message = undefined;
        }
        if (message === undefined) continue;
        this.messages.push(message);
        if (typeof message.id === 'number') this.waiters.get(message.id)?.(message);
      }
    })();
  }

  /** The process's final result: waits for stdout to be read to its end first. */
  exit(): Promise<CommandResult> {
    this.ended ??= (async () => {
      const result = await this.stream.result;
      await this.pumped;
      return result;
    })();
    return this.ended;
  }

  send(message: Record<string, unknown>): void {
    this.stdin.push(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  }

  async request(method: string, params: Record<string, unknown> = {}): Promise<RpcMessage> {
    const id = this.nextId++;
    const reply = new Promise<RpcMessage>((resolve) => {
      this.waiters.set(id, resolve);
    });
    const gone = this.exit().then((result) => assert.fail(`the server exited (code ${String(result.exitCode)}) before answering ${method}: ${Buffer.from(result.stderr).toString('utf8').trim()}`));
    this.send({ id, method, params });
    return within(REPLY_CEILING_MS, `the reply to ${method}`, Promise.race([reply, gone]));
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    this.send({ method, params });
  }

  /** `initialize` (2025-06-18, empty capabilities) and the `initialized` notification. */
  async handshake(): Promise<RpcMessage> {
    const init = await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'mcp-stdio-test', version: '0.0.0' },
    });
    this.notify('notifications/initialized');
    return init;
  }

  async listTools(): Promise<Array<{ name: string; annotations?: { readOnlyHint?: boolean } }>> {
    const listed = await this.request('tools/list');
    return (listed.result as { tools: Array<{ name: string; annotations?: { readOnlyHint?: boolean } }> }).tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolCall> {
    const reply = await this.request('tools/call', { name, arguments: args });
    const result = reply.result as unknown as ToolResult;
    assert.ok(result !== undefined, `tools/call ${name} returned no result: ${JSON.stringify(reply)}`);
    assert.equal(result.content.length, 1, 'one text content item');
    assert.equal(result.content[0]?.type, 'text');
    return { reply, result, envelope: JSON.parse(result.content[0]?.text ?? '') as Envelope };
  }

  /** Close the child's stdin: the server's signal to finish. */
  endInput(): void {
    this.stdin.end();
  }

  /** SIGKILL, as a crash or a host that gives up. */
  kill(): void {
    this.stream.kill();
  }

  /** End input and wait for the exit, as the clean shutdown path. */
  async shutdown(): Promise<CommandResult> {
    this.endInput();
    return within(EXIT_CEILING_MS, 'the server to exit after end of input', this.exit());
  }
}

export interface Fixture {
  readonly repo: TempGitRepo;
  readonly tmp: TempDir;
  /** The environment the server runs in: isolated git, HOME and user directory. */
  readonly env: Readonly<Record<string, string>>;
  /** A directory that is not a repository, used as the server's working directory. */
  readonly outside: string;
  start(cwd?: string, extraEnv?: Readonly<Record<string, string>>): McpProcess;
}

function sink(): { write(text: string): boolean } {
  return { write: () => true };
}

export interface FixtureOptions {
  readonly files?: Readonly<Record<string, string>>;
  /** Build the index before the test starts (default true). */
  readonly build?: boolean;
}

/** A temporary repository whose index was built by the real Host in this process, which then let go of it. */
export async function makeFixture(t: TestContext, options: FixtureOptions = {}): Promise<Fixture> {
  const tmp = makeTempDir();
  const setupRunner = createRealRunner({ decide: allowAll });
  const repo = await createTempGitRepo({ runner: setupRunner, world: { committed: options.files ?? FILES } });
  const userDir = path.join(tmp.path, 'user');
  const env: Record<string, string> = { ...repo.envOverlay, GSD_ATLAS_USER_DIR: userDir };
  const outside = path.join(tmp.path, 'outside');
  fs.mkdirSync(outside);
  const started: McpProcess[] = [];
  t.after(async () => {
    for (const each of started) {
      each.kill();
      await each.exit();
    }
    tmp.cleanup();
    repo.cleanup();
  });
  if (options.build !== false) {
    const composed = composeHost({ cwd: outside, env: { ...process.env, ...env }, home: env['HOME'] as string, stderr: sink() });
    try {
      const built = await composed.client.handle({ protocol: PROTOCOL_VERSION, kind: 'build', args: { repo: repo.dir } });
      assert.equal(built.ok, true, `the fixture build failed: ${JSON.stringify(built.diagnostics)}`);
    } finally {
      await composed.dispose();
    }
  }
  return {
    repo,
    tmp,
    env,
    outside,
    start(cwd = outside, extraEnv = {}) {
      const child = new McpProcess(cwd, { ...env, ...extraEnv });
      started.push(child);
      return child;
    },
  };
}

interface FindRow {
  readonly name: string;
  readonly path: string;
  readonly line: number;
  readonly citation: string;
}

export const findRows = (envelope: Envelope): FindRow[] => (envelope.data as { results: FindRow[] }).results;

describe('gsd-atlas-mcp over stdio: the default profile and a first tool call', () => {
  it('tools/list over a real stdio session returns exactly the six tools, each read-only', async (t) => {
    const fixture = await makeFixture(t);
    const server = fixture.start();
    const init = await server.handshake();
    assert.equal((init.result as { serverInfo: { name: string } }).serverInfo.name, 'gsd-atlas');
    const tools = await server.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), [...TOOL_NAMES].sort());
    assert.ok(tools.every((tool) => tool.annotations?.readOnlyHint === true));
    const exit = await server.shutdown();
    assert.equal(exit.exitCode, 0, Buffer.from(exit.stderr).toString('utf8'));
  });

  it('tools/call code_find answers the definition from the built index, as one envelope in one text item', async (t) => {
    const fixture = await makeFixture(t);
    const server = fixture.start();
    await server.handshake();
    const call = await server.callTool('code_find', { name: 'load', repo: fixture.repo.dir });
    assert.notEqual(call.result.isError, true, call.result.content[0]?.text);
    assert.equal(call.envelope.schema, 'gsd-atlas.code-find/1');
    assert.equal(call.envelope.ok, true);
    const first = findRows(call.envelope)[0];
    assert.equal(first?.name, 'load');
    assert.equal(first?.path, 'a.ts');
    assert.equal(first?.line, 1);
    const citations = call.envelope['citations'] as Array<{ id: string; path: string }>;
    assert.ok(citations.some((citation) => citation.id === first?.citation && citation.path === 'a.ts'), 'the result is cited');
    for (const line of server.lines) assert.doesNotThrow(() => JSON.parse(line), `every stdout line is JSON: ${line}`);
    await server.shutdown();
  });

  it('closing stdin ends the process with exit code 0', async (t) => {
    const fixture = await makeFixture(t);
    const server = fixture.start();
    await server.handshake();
    const exit = await server.shutdown();
    assert.equal(exit.exitCode, 0, Buffer.from(exit.stderr).toString('utf8'));
    assert.equal(exit.signal, null);
  });
});
