// Drives the built atlas MCP shim over stdio, the way an agent would, and records per call: bytes, estimated tokens,
// whether source text is included, whether the answer is paginated. No model, no network. Read-only on the corpus
// (the index lives under XDG_CACHE_HOME, which the caller points at a scratch directory).
//
//   node scripts/design-probe/run-atlas.ts --dist <worktree>/dist --repo <checkout> --plan <plan.json> --out <records.json>
//
// plan.json: [{ id, corpus, steps: [{ tool, args, page: true|false }] }]. A paged step follows `more` until absent.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { estimateTokens, utf8Bytes } from './measure-lib.ts';

interface Step { readonly tool: string; readonly args: Record<string, unknown>; readonly page?: boolean; readonly maxPages?: number }
interface PlanItem { readonly id: string; readonly steps: readonly Step[] }

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0 || process.argv[i + 1] === undefined) throw new Error(`missing --${name}`);
  return process.argv[i + 1] as string;
}

const dist = arg('dist');
const repo = arg('repo');
const plan = JSON.parse(readFileSync(arg('plan'), 'utf8')) as PlanItem[];
const outFile = arg('out');

const child = spawn('node', [`${dist}/bin/gsd-atlas-mcp.js`], { stdio: ['pipe', 'pipe', 'inherit'], env: process.env });
let buffer = '';
const waiting = new Map<number, (message: any) => void>();
child.stdout.on('data', (chunk: Buffer) => {
  buffer += chunk.toString('utf8');
  let nl: number;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    if (line.trim() === '') continue;
    const message = JSON.parse(line);
    waiting.get(message.id)?.(message);
  }
});
let nextId = 0;
function rpc(method: string, params: unknown): Promise<any> {
  return new Promise((resolve) => {
    const id = ++nextId;
    waiting.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

function pathsIn(value: unknown, out: Set<string>, skip: string[] = []): void {
  if (Array.isArray(value)) { for (const v of value) pathsIn(v, out, skip); return; }
  if (typeof value !== 'object' || value === null) return;
  for (const [k, v] of Object.entries(value)) {
    if (skip.includes(k)) continue;
    if (k === 'path' && typeof v === 'string') out.add(v);
    else pathsIn(v, out, skip);
  }
}

interface CallRecord {
  question: string; tool: string; args: Record<string, unknown>; bytes: number; tokens: number;
  dataBytes: number; citationBytes: number; untrustedBytes: number; untrustedEntries: number;
  resultCount: number; truncated: boolean; hasMore: boolean; files: string[]; dataKeys: string[];
}

await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'design-probe', version: '0' } });
child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
const listing = await rpc('tools/list', {});

const records: CallRecord[] = [];
for (const item of plan) {
  for (const step of item.steps) {
    let more: string | undefined;
    for (let page = 0; page < (step.page === true ? (step.maxPages ?? 40) : 1); page++) {
      const args = { ...step.args, repo, ...(more === undefined ? {} : { more }) };
      const reply = await rpc('tools/call', { name: step.tool, arguments: args });
      const text: string = reply.result?.content?.[0]?.text ?? JSON.stringify(reply);
      const envelope = JSON.parse(text);
      const files = new Set<string>();
      pathsIn(envelope.data, files, ['targets']);
      const results = Array.isArray(envelope.data?.results) ? envelope.data.results.length : 0;
      records.push({
        question: item.id, tool: step.tool, args: step.args, bytes: utf8Bytes(text), tokens: estimateTokens(utf8Bytes(text)),
        dataBytes: utf8Bytes(JSON.stringify(envelope.data ?? null)), citationBytes: utf8Bytes(JSON.stringify(envelope.citations ?? null)),
        untrustedBytes: utf8Bytes(JSON.stringify(envelope.untrusted_text ?? null)), untrustedEntries: envelope.untrusted_text?.entries?.length ?? 0,
        resultCount: results, truncated: envelope.truncated === true, hasMore: typeof envelope.more === 'string', files: [...files].sort(),
        dataKeys: Object.keys(envelope.data ?? {}),
      });
      more = typeof envelope.more === 'string' ? envelope.more : undefined;
      if (more === undefined) break;
    }
  }
}
const fixed = { toolsListBytes: utf8Bytes(JSON.stringify(listing.result)), toolCount: listing.result.tools.length };
writeFileSync(outFile, JSON.stringify({ fixed, records }, null, 1));
child.kill();
