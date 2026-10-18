/**
 * The MCP server over an in-memory transport with a recording fake HostClient: which tools are registered, what
 * each call sends to the Host, and what comes back. The real-process behaviour (stdio framing, restart, EOF) is
 * tested in scripts/mcp-stdio.test.ts.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { InMemoryTransport } from '@modelcontextprotocol/server';
import type { JSONRPCMessage } from '@modelcontextprotocol/server';

import { TOOLS, TOOL_NAMES, buildRequest } from '../host-client/index.ts';
import type { Envelope, HostClient, Request } from '../host-client/index.ts';
import { buildMcpServer } from './server.ts';

const CANNED: Envelope = {
  schema: 'gsd-atlas.code-find/1',
  ok: true,
  data: { results: [{ name: 'x', path: 'a.ts', line: 1 }] },
  diagnostics: [],
};

/** A HostClient that records every request and answers with `answer` (or throws it). */
function recordingClient(answer: Envelope | Error): HostClient & { readonly requests: Request[] } {
  const requests: Request[] = [];
  return {
    requests,
    handle(request) {
      requests.push(request);
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
  };
}

interface Reply {
  readonly id: number;
  readonly result?: Record<string, unknown>;
  readonly error?: { readonly code: number; readonly message: string };
}

/** A tiny JSON-RPC client over the linked in-memory pair: no MCP client package is installed. */
async function connect(client: HostClient, options: { instructions?: string } = {}) {
  const server = buildMcpServer(client, { version: '9.9.9', ...options });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const pending = new Map<number, (reply: Reply) => void>();
  clientSide.onmessage = (message: JSONRPCMessage) => {
    const reply = message as unknown as Reply;
    if (typeof reply.id === 'number') pending.get(reply.id)?.(reply);
  };
  await server.connect(serverSide);
  await clientSide.start();
  let nextId = 1;
  const request = (method: string, params: Record<string, unknown> = {}): Promise<Reply> =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      void clientSide.send({ jsonrpc: '2.0', id, method, params } as JSONRPCMessage);
    });
  const init = await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '0.0.0' },
  });
  await clientSide.send({ jsonrpc: '2.0', method: 'notifications/initialized' } as JSONRPCMessage);
  return {
    init,
    request,
    call: (name: string, args: Record<string, unknown>) => request('tools/call', { name, arguments: args }),
    close: async () => {
      await clientSide.close();
      await server.close();
    },
  };
}

interface ListedTool {
  readonly name: string;
  readonly description?: string;
  readonly annotations?: { readonly readOnlyHint?: boolean };
  readonly inputSchema?: { readonly additionalProperties?: unknown };
}

interface CallResult {
  readonly content: ReadonlyArray<{ readonly type: string; readonly text: string }>;
  readonly isError?: boolean;
}

describe('buildMcpServer: the default profile (D-07, QRY-06)', () => {
  it('registers exactly the six shared tools, each read-only with a strict schema, and nothing else', async () => {
    const mcp = await connect(recordingClient(CANNED));
    try {
      const listed = await mcp.request('tools/list');
      const tools = (listed.result as { tools: ListedTool[] }).tools;
      assert.deepEqual(tools.map((tool) => tool.name).sort(), [...TOOL_NAMES].sort());
      assert.equal(tools.length, 6);
      for (const tool of tools) {
        assert.equal(tool.annotations?.readOnlyHint, true, `${tool.name} is read-only`);
        assert.equal(tool.inputSchema?.additionalProperties, false, `${tool.name} refuses unknown arguments`);
        const shared = TOOLS.find((definition) => definition.name === tool.name);
        assert.equal(tool.description, shared?.description, `${tool.name} carries the shared description`);
      }
    } finally {
      await mcp.close();
    }
  });

  it('no rating tool (D-16, T-03-172): no tool is named rate or rating, none takes a value of up, meh or down, and a call to rate reaches no Host', async () => {
    const client = recordingClient(CANNED);
    const mcp = await connect(client);
    try {
      const listed = await mcp.request('tools/list');
      const tools = (listed.result as { tools: ListedTool[] }).tools;
      for (const tool of tools) {
        assert.doesNotMatch(tool.name, /rat(e|ing)/, tool.name);
        const schema = JSON.stringify(tool.inputSchema);
        assert.doesNotMatch(schema, /"(up|meh|down)"/, `${tool.name} offers no rating value`);
        assert.doesNotMatch(schema, /"(value|rating|scope|answer_id)"\s*:/, `${tool.name} takes no rating argument`);
      }
      const called = await mcp.call('rate', { value: 'up', scope: 'answer' });
      const result = called.result as CallResult | undefined;
      assert.ok(called.error !== undefined || result?.isError === true, 'an unknown tool is an error');
      assert.deepEqual(client.requests, [], 'nothing was sent to the Host');
    } finally {
      await mcp.close();
    }
  });

  it('reports the package version and the fixed instructions, which say repository text is data', async () => {
    const mcp = await connect(recordingClient(CANNED));
    try {
      const result = mcp.init.result as { serverInfo: { name: string; version: string }; instructions?: string };
      assert.equal(result.serverInfo.name, 'gsd-atlas');
      assert.equal(result.serverInfo.version, '9.9.9');
      for (const name of TOOL_NAMES) assert.match(result.instructions ?? '', new RegExp(name), `instructions route ${name}`);
      assert.match(result.instructions ?? '', /untrusted_text/);
      assert.match(result.instructions ?? '', /data/);
    } finally {
      await mcp.close();
    }
  });
});

describe('buildMcpServer: tool calls', () => {
  it('code_find sends exactly the request buildRequest builds and returns the envelope as the one text item', async () => {
    const client = recordingClient(CANNED);
    const mcp = await connect(client);
    try {
      const reply = await mcp.call('code_find', { name: 'x', repo: '/r' });
      assert.deepEqual(client.requests, [buildRequest('code_find', { name: 'x', repo: '/r' })]);
      const result = reply.result as unknown as CallResult;
      assert.equal(result.content.length, 1);
      assert.equal(result.content[0]?.type, 'text');
      assert.equal(result.content[0]?.text, JSON.stringify(CANNED));
      assert.equal(result.isError, false);
    } finally {
      await mcp.close();
    }
  });

  it('budget_tokens and fresh ride at the request level, exactly as the CLI sends them', async () => {
    const client = recordingClient(CANNED);
    const mcp = await connect(client);
    try {
      await mcp.call('code_refs', { name: 'x', budget_tokens: 500, fresh: ['a.ts'], cwd: '/r/src' });
      assert.deepEqual(client.requests, [buildRequest('code_refs', { name: 'x', budget_tokens: 500, fresh: ['a.ts'], cwd: '/r/src' })]);
      assert.equal(client.requests[0]?.budget_tokens, 500);
    } finally {
      await mcp.close();
    }
  });

  it('every one of the six tools builds its request with buildRequest', async () => {
    const client = recordingClient(CANNED);
    const mcp = await connect(client);
    try {
      const inputs: Record<string, Record<string, unknown>> = {
        code_find: { name: 'x' },
        code_refs: { name: 'x' },
        code_context: { name: 'x' },
        code_impact: { name: 'x', depth: 1 },
        atlas_status: { repo: '/r' },
        lang_list: {},
      };
      for (const name of TOOL_NAMES) await mcp.call(name, inputs[name] as Record<string, unknown>);
      assert.deepEqual(
        client.requests,
        TOOL_NAMES.map((name) => buildRequest(name, inputs[name] as Record<string, unknown>)),
      );
    } finally {
      await mcp.close();
    }
  });

  it('a not-ok envelope comes back with isError true and the identical text', async () => {
    const failed: Envelope = {
      schema: 'gsd-atlas.error/1',
      ok: false,
      data: null,
      diagnostics: [{ code: 'not_a_repo', severity: 'error', message: 'not a repository' }],
    };
    const mcp = await connect(recordingClient(failed));
    try {
      const result = (await mcp.call('code_find', { name: 'x' })).result as unknown as CallResult;
      assert.equal(result.isError, true);
      assert.equal(result.content.length, 1);
      assert.equal(result.content[0]?.text, JSON.stringify(failed));
    } finally {
      await mcp.close();
    }
  });

  it('a client that throws becomes an error result with a fixed message, never a crash, and the server keeps answering', async () => {
    const reported: unknown[] = [];
    const client = recordingClient(new Error('secret detail /home/user/private'));
    const server = buildMcpServer(client, { version: '1.0.0', onError: (error) => reported.push(error) });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const replies: Reply[] = [];
    clientSide.onmessage = (message: JSONRPCMessage) => {
      replies.push(message as unknown as Reply);
    };
    await server.connect(serverSide);
    await clientSide.start();
    const send = async (id: number, method: string, params: Record<string, unknown>): Promise<Reply> => {
      await clientSide.send({ jsonrpc: '2.0', id, method, params } as JSONRPCMessage);
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const found = replies.find((reply) => reply.id === id);
        if (found !== undefined) return found;
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 5);
        });
      }
      throw new Error(`no reply to ${method}`);
    };
    try {
      await send(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
      const failed = (await send(2, 'tools/call', { name: 'code_find', arguments: { name: 'x' } })).result as unknown as CallResult;
      assert.equal(failed.isError, true);
      assert.equal(failed.content.length, 1);
      assert.doesNotMatch(failed.content[0]?.text ?? '', /secret detail|private/, 'the thrown text never reaches the agent');
      assert.equal(reported.length, 1, 'the cause goes to the operator through onError');
      const again = await send(3, 'tools/list', {});
      assert.equal((again.result as { tools: unknown[] }).tools.length, 6);
    } finally {
      await clientSide.close();
      await server.close();
    }
  });
});

describe('buildMcpServer: invalid arguments never reach the Host', () => {
  const rejected = (reply: Reply): boolean => reply.error !== undefined || (reply.result as unknown as CallResult | undefined)?.isError === true;

  it('an unknown property is refused by the schema', async () => {
    const client = recordingClient(CANNED);
    const mcp = await connect(client);
    try {
      const reply = await mcp.call('code_find', { name: 'x', surprise: true });
      assert.ok(rejected(reply), `expected a refusal, got ${JSON.stringify(reply)}`);
      assert.equal(client.requests.length, 0);
    } finally {
      await mcp.close();
    }
  });

  it('a missing name is refused by the schema', async () => {
    const client = recordingClient(CANNED);
    const mcp = await connect(client);
    try {
      const reply = await mcp.call('code_find', {});
      assert.ok(rejected(reply), `expected a refusal, got ${JSON.stringify(reply)}`);
      assert.equal(client.requests.length, 0);
    } finally {
      await mcp.close();
    }
  });

  it('a wrongly typed budget_tokens is refused by the schema', async () => {
    const client = recordingClient(CANNED);
    const mcp = await connect(client);
    try {
      const reply = await mcp.call('code_find', { name: 'x', budget_tokens: 'many' });
      assert.ok(rejected(reply), `expected a refusal, got ${JSON.stringify(reply)}`);
      assert.equal(client.requests.length, 0);
    } finally {
      await mcp.close();
    }
  });
});
