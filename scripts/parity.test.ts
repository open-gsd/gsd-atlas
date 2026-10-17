/**
 * CLI and MCP parity as real processes (QRY-04, QRY-05; plan 02-25): the same request against the same index returns
 * identical JSON from `src/bin/gsd-atlas.ts` and from `src/bin/gsd-atlas-mcp.ts`. Both are started through the
 * CommandRunner (`createRealRunner`, no shell) in an isolated environment (HOME, user directory, git configuration).
 *
 * The comparison is on strings: the CLI's stdout line equals the MCP result text after the per-response nonce is
 * replaced by a fixed token, and nothing else is masked. A failure prints the stderr of both processes.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { maskNonce, withFixture } from './test-helpers/fixture-repo.ts';
import type { CliRun, FixtureRepo } from './test-helpers/fixture-repo.ts';
import type { Envelope, McpClient } from './test-helpers/mcp-client.ts';

interface Row {
  readonly name: string;
  readonly path: string;
  readonly line: number;
  readonly citation: string;
  readonly [key: string]: unknown;
}

const rowsOf = (envelope: Envelope): Row[] => (envelope.data as { results: Row[] }).results;

/** The one JSON line a CLI run printed, without its newline. */
function cliLine(run: CliRun): string {
  assert.ok(run.stdout.endsWith('\n') && run.stdout.indexOf('\n') === run.stdout.length - 1, `stdout must be one JSON line, got ${JSON.stringify(run.stdout)}`);
  return run.stdout.slice(0, -1);
}

/** Build the index with the CLI; the process exits afterwards, so the lease is free for the next process. */
async function build(fixture: FixtureRepo, repo = fixture.dir): Promise<void> {
  const built = await fixture.cli(['build', '--repo', repo]);
  assert.equal(built.code, 0, built.stderr);
}

/** What the two surfaces answered to one request. */
interface Pair {
  readonly cli: CliRun;
  readonly line: string;
  readonly text: string;
  readonly isError: boolean | undefined;
  readonly envelope: Envelope;
}

/** Ask the CLI first (its process ends), then the MCP server, and compare after masking the nonce. */
async function askBoth(fixture: FixtureRepo, server: McpClient, cliArgs: readonly string[], tool: string, mcpArgs: Record<string, unknown>): Promise<Pair> {
  const cli = await fixture.cli(cliArgs);
  const line = cliLine(cli);
  const call = await server.callTool(tool, mcpArgs);
  const text = call.result.content[0]?.text ?? '';
  assert.equal(maskNonce(line), maskNonce(text), `the CLI line and the MCP result text for ${tool} differ`);
  return { cli, line, text, isError: call.result.isError, envelope: call.envelope };
}

describe('CLI and MCP parity on the TypeScript import chain', () => {
  it('find: the CLI stdout line equals the MCP result text after the nonce is masked, with the definition cited', async () => {
    await withFixture('ts-three-files', async (fixture) => {
      await build(fixture);

      const cli = await fixture.cli(['find', 'parse', '--repo', fixture.dir]);
      assert.equal(cli.code, 0, cli.stderr);
      const line = cliLine(cli);

      // The CLI process has exited, so the server is the leader on its first call.
      const server = fixture.mcp();
      await server.initialize();
      const call = await server.callTool('code_find', { name: 'parse', repo: fixture.dir });
      const text = call.result.content[0]?.text ?? '';

      assert.equal(maskNonce(line), maskNonce(text));
      assert.notEqual(call.result.isError, true, text);
      const envelope = JSON.parse(line) as Envelope;
      assert.equal(envelope.schema, 'gsd-atlas.code-find/1');
      assert.equal(envelope.ok, true);
      const first = rowsOf(envelope)[0];
      assert.equal(first?.name, 'parse');
      assert.equal(first?.path, 'a.ts');
      assert.equal(first?.line, 1);
      const citations = envelope['citations'] as Array<{ id: string; path: string }>;
      assert.ok(citations.some((citation) => citation.id === first?.citation && citation.path === 'a.ts'), 'the definition is cited');
      const fenced = envelope['untrusted_text'] as { nonce: string; entries: Array<{ text: string }> };
      assert.ok(fenced.nonce !== '' && fenced.entries.some((entry) => entry.text.includes('function parse')), 'the matched line is fenced');

      const exit = await server.close();
      assert.equal(exit.exitCode, 0, server.stderrText());
    });
  });
});
