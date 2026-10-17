/**
 * The shared stdio MCP client of the end-to-end tests (plan 02-25): `startMcp` starts the real `gsd-atlas-mcp` bin
 * through the CommandRunner (`createRealRunner`, no shell) and returns a small JSON-RPC client over its stdin and stdout.
 *
 * The line framing, the id matching and the stdin queue are the ones in `mcp-process.ts` (`McpProcess`), which the
 * plan-02-23 tests already use; `McpClient` is a subclass that adds what the product-level tests need on top: every
 * stdout line is checked to be a JSON-RPC 2.0 object as it arrives (a stray write fails the test at the next call),
 * the exit result is remembered, and a failing test can ask for the stderr of the process.
 *
 * Latencies are never asserted to the millisecond: the ceilings only turn a hung child into a failed test.
 */
import assert from 'node:assert/strict';
import path from 'node:path';

import type { CommandResult } from '../../src/command-runner/index.ts';
import { McpProcess, stderrOf } from './mcp-process.ts';
import type { Envelope, ListedTool, RpcMessage, ToolCall } from './mcp-process.ts';

export type { Envelope, ListedTool, RpcMessage, ToolCall };

/** The source entry of the stdio server, run by `node` with native type stripping. */
export const MCP_BIN = path.resolve(import.meta.dirname, '..', '..', 'src', 'bin', 'gsd-atlas-mcp.ts');

export interface StartMcpOptions {
  /** The server's working directory; without a `repo` argument it is the repository the server answers about. */
  readonly cwd: string;
  /** Laid over the (scrubbed) environment of this process: isolated HOME, GSD_ATLAS_USER_DIR and git configuration. */
  readonly env: Readonly<Record<string, string>>;
  /** The bin to run; the source bin by default. */
  readonly bin?: string;
}

/** Throws if a stdout line is not one JSON-RPC 2.0 message object. `from` is the index of the first line to check. */
export function assertFramedLines(lines: readonly string[], from = 0): void {
  for (const line of lines.slice(from)) {
    let parsed: unknown;
    assert.doesNotThrow(() => {
      parsed = JSON.parse(line);
    }, `a stdout line is not JSON: ${JSON.stringify(line)}`);
    assert.ok(typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed), `a stdout line is not an object: ${JSON.stringify(line)}`);
    assert.equal((parsed as RpcMessage).jsonrpc, '2.0', `a stdout line is not JSON-RPC 2.0: ${JSON.stringify(line)}`);
  }
}

/**
 * A {@link McpProcess} with the checks and conveniences the product-level tests share. It is a subclass, so every
 * test written against `McpProcess` (raw frames, `request`, `sendTogether`, `endInput`, `kill`) works on it unchanged.
 */
export class McpClient extends McpProcess {
  private finished: CommandResult | undefined;
  private checked = 0;

  constructor(options: StartMcpOptions) {
    super(options.bin ?? MCP_BIN, options.cwd, options.env);
    void this.exit().then(
      (result) => {
        this.finished = result;
      },
      () => undefined,
    );
  }

  /** Every stdout line seen so far is a JSON-RPC 2.0 object. */
  private checkFraming(): void {
    assertFramedLines(this.lines, this.checked);
    this.checked = this.lines.length;
  }

  /** `initialize` and the `initialized` notification; resolves to the initialize reply. */
  initialize(): Promise<RpcMessage> {
    return this.handshake();
  }

  override async handshake(): Promise<RpcMessage> {
    const reply = await super.handshake();
    this.checkFraming();
    return reply;
  }

  override async listTools(): Promise<ListedTool[]> {
    const tools = await super.listTools();
    this.checkFraming();
    return tools;
  }

  override async callTool(name: string, args: Record<string, unknown>): Promise<ToolCall> {
    const call = await super.callTool(name, args);
    this.checkFraming();
    return call;
  }

  /** Close stdin and wait for the exit; checks that every stdout line was a JSON-RPC object. */
  async close(): Promise<CommandResult> {
    const result = await this.shutdown();
    this.checkFraming();
    return result;
  }

  /** The stderr of the process once it has exited, and the empty string while it still runs. */
  stderrText(): string {
    return this.finished === undefined ? '' : stderrOf(this.finished);
  }

  /** Kills the process if it still runs and returns its stderr: what a failing test prints. */
  async killAndStderr(): Promise<string> {
    if (this.finished === undefined) this.kill();
    return stderrOf(await this.exit());
  }
}

export function startMcp(options: StartMcpOptions): McpClient {
  return new McpClient(options);
}
