/**
 * Builds a scratch copy of the compiled MCP server with one or more of: no server instructions, a subset of
 * the tools, a default `budget_tokens` on the code tools, shortened tool descriptions. The repository's `src/`
 * and `dist/` are never modified: the copy lives in a scratch directory, with `node_modules` linked.
 * Exploratory; a patched copy measures an idea, it is not the product.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface PatchOptions {
  /** `false` removes the server instructions. */
  instructions?: boolean;
  /** Register only these tools. */
  tools?: readonly string[];
  /** Default `budget_tokens` for code_find, code_refs, code_context and code_impact. */
  budgetTokens?: number;
  /** Drop the fence note from each tool description. */
  shortDescriptions?: boolean;
}

const CODE_TOOLS = ['code_find', 'code_refs', 'code_context', 'code_impact'];

function replaceOnce(source: string, anchor: string, replacement: string): string {
  const first = source.indexOf(anchor);
  if (first === -1 || source.indexOf(anchor, first + 1) !== -1) throw new Error(`patch anchor not found exactly once: ${anchor}`);
  return source.slice(0, first) + replacement + source.slice(first + anchor.length);
}

export function patchServerSource(source: string, options: PatchOptions): string {
  let out = source;
  if (options.instructions === false) out = replaceOnce(out, 'options.instructions ?? SERVER_INSTRUCTIONS', 'undefined');
  if (options.tools !== undefined) {
    out = replaceOnce(out, 'for (const tool of TOOLS) {', `for (const tool of TOOLS.filter((t) => new Set(${JSON.stringify([...options.tools])}).has(t.name))) {`);
  }
  if (options.budgetTokens !== undefined) {
    out = replaceOnce(
      out,
      'buildRequest(tool.name, asRecord(args))',
      `buildRequest(tool.name, ${JSON.stringify(CODE_TOOLS)}.includes(tool.name) ? { budget_tokens: ${String(options.budgetTokens)}, ...asRecord(args) } : asRecord(args))`,
    );
  }
  if (options.shortDescriptions === true) {
    out = replaceOnce(out, 'description: tool.description,', "description: (tool.description.split(' Source text comes back')[0] ?? tool.description),");
  }
  return out;
}

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');

/**
 * Copies `dist/` (the build in this worktree) to `<dir>/dist`, patches `mcp-shim/server.js`, links
 * `node_modules` and copies `package.json`. Returns the path of the copy's `gsd-atlas-mcp.js`.
 */
export function makePatchedCopy(dir: string, options: PatchOptions): string {
  fs.mkdirSync(dir, { recursive: true });
  fs.cpSync(path.join(REPO_ROOT, 'dist'), path.join(dir, 'dist'), { recursive: true });
  fs.copyFileSync(path.join(REPO_ROOT, 'package.json'), path.join(dir, 'package.json'));
  const link = path.join(dir, 'node_modules');
  if (!fs.existsSync(link)) fs.symlinkSync(path.join(REPO_ROOT, 'node_modules'), link, 'dir');
  const target = path.join(dir, 'dist', 'mcp-shim', 'server.js');
  fs.writeFileSync(target, patchServerSource(fs.readFileSync(target, 'utf8'), options));
  return path.join(dir, 'dist', 'bin', 'gsd-atlas-mcp.js');
}
