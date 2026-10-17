/**
 * Test support shared by scripts/mcp-stdio.test.ts and scripts/package.test.ts (plan 02-23): a gsd-atlas-mcp process
 * started through the CommandRunner with a controllable stdin, and a small JSON-RPC client over its stdout. Lives
 * outside `src` so it is neither built nor run as a test.
 *
 * Latencies are never asserted to the millisecond: the ceilings only turn a hung child into a failed test.
 */
import assert from 'node:assert/strict';

import { allowAll, createRealRunner } from '../../src/command-runner/index.ts';
import type { CommandResult, CommandStream } from '../../src/command-runner/index.ts';
import { lineReader, within } from './child-lines.ts';

const runner = createRealRunner({ decide: allowAll });

export const REPLY_CEILING_MS = 90_000;
export const EXIT_CEILING_MS = 60_000;

/** An async queue of stdin chunks: the child's stdin stays open until `end()`. */
export class StdinQueue implements AsyncIterable<string> {
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

export interface ListedTool {
  readonly name: string;
  readonly annotations?: { readonly readOnlyHint?: boolean };
}

/** A test-side JSON-RPC client over a gsd-atlas-mcp bin's stdin and stdout. */
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

  /** Starts `node <bin>` in `cwd` with `env` laid over the (scrubbed) environment of this process. */
  constructor(bin: string, cwd: string, env: Readonly<Record<string, string>>) {
    this.stream = runner.stream({ executable: process.execPath, args: [bin], cwd, env, stdin: this.stdin });
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

  /** Several messages in ONE stdin chunk, as a client that writes them together would. */
  sendTogether(messages: ReadonlyArray<Record<string, unknown>>): void {
    this.stdin.push(messages.map((message) => `${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`).join(''));
  }

  /** Allocate the id the next request will carry, for a caller that builds its own message. */
  takeId(): number {
    return this.nextId++;
  }

  async request(method: string, params: Record<string, unknown> = {}): Promise<RpcMessage> {
    const id = this.takeId();
    const reply = new Promise<RpcMessage>((resolve) => {
      this.waiters.set(id, resolve);
    });
    const gone = this.exit().then((result) =>
      assert.fail(`the server exited (code ${String(result.exitCode)}, signal ${String(result.signal)}) before answering ${method}: ${Buffer.from(result.stderr).toString('utf8').trim()}`),
    );
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

  async listTools(): Promise<ListedTool[]> {
    const listed = await this.request('tools/list');
    return (listed.result as { tools: ListedTool[] }).tools;
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
    try {
      return await within(EXIT_CEILING_MS, 'the server to exit after end of input', this.exit());
    } catch (error) {
      // A hung server: kill it so its own stderr can say where it was, and report that with the failure.
      this.kill();
      const killed = await this.exit();
      throw new Error(`${error instanceof Error ? error.message : String(error)}; stderr: ${Buffer.from(killed.stderr).toString('utf8').trim()}`);
    }
  }
}

export const stderrOf = (result: CommandResult): string => Buffer.from(result.stderr).toString('utf8');
