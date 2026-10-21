import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { makePatchedCopy, patchServerSource } from './patch-server.ts';

const SOURCE = `import { TOOLS, buildRequest } from "../host-client/index.js";
export function buildMcpServer(client, options) {
    const server = new McpServer({ name: 'gsd-atlas', version: options.version }, { capabilities: { tools: {} }, instructions: options.instructions ?? SERVER_INSTRUCTIONS });
    for (const tool of TOOLS) {
        server.registerTool(tool.name, {
            title: tool.title,
            description: tool.description,
            inputSchema: tool.inputSchema,
        }, async (args) => {
            const envelope = await client.handle(buildRequest(tool.name, asRecord(args)));
        });
    }
}`;

describe('patchServerSource', () => {
  it('drops the instructions', () => {
    const out = patchServerSource(SOURCE, { instructions: false });
    assert.match(out, /instructions: undefined/);
    assert.doesNotMatch(out, /options\.instructions \?\? SERVER_INSTRUCTIONS/);
  });
  it('registers only the named tools', () => {
    const out = patchServerSource(SOURCE, { tools: ['code_find', 'code_refs'] });
    assert.match(out, /new Set\(\["code_find","code_refs"\]\)/);
    assert.match(out, /for \(const tool of TOOLS\.filter\(/);
  });
  it('injects a default budget for code tools only, and never over an explicit argument', () => {
    const out = patchServerSource(SOURCE, { budgetTokens: 900 });
    assert.match(out, /budget_tokens: 900/);
    assert.match(out, /\.\.\.asRecord\(args\)/);
    assert.match(out, /code_find/);
  });
  it('shortens descriptions to the sentence before the fence note', () => {
    const out = patchServerSource(SOURCE, { shortDescriptions: true });
    assert.match(out, /Source text comes back/);
    assert.match(out, /description: \(/);
  });
  it('leaves the source unchanged when no option is set', () => {
    assert.equal(patchServerSource(SOURCE, {}), SOURCE);
  });
  it('refuses a source whose anchor is missing', () => {
    assert.throws(() => patchServerSource('nothing here', { instructions: false }), /anchor/);
  });
});

describe('makePatchedCopy', () => {
  const dist = path.resolve(import.meta.dirname, '..', '..', 'dist', 'mcp-shim', 'server.js');
  it('writes a patched copy of the build that still has the real bin next to it', { skip: !fs.existsSync(dist) }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'patched-copy-'));
    try {
      const bin = makePatchedCopy(dir, { instructions: false, tools: ['code_find'] });
      assert.ok(fs.existsSync(bin));
      assert.ok(bin.endsWith('gsd-atlas-mcp.js'));
      const server = fs.readFileSync(path.join(dir, 'dist', 'mcp-shim', 'server.js'), 'utf8');
      assert.match(server, /instructions: undefined/);
      assert.ok(fs.lstatSync(path.join(dir, 'node_modules')).isSymbolicLink());
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
