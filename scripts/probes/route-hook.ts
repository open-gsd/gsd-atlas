/**
 * A PreToolUse hook for the forced-routing probe (P3, condition iii). It denies Bash commands that search
 * code with grep, rg, git grep, find or cat, and tells the model to use the gsd-atlas tools. It is passed to
 * the session only through `--settings` JSON; no user or project settings file is touched.
 *
 * Forced routing changes what is measured: the grep arm's only search route is closed on purpose.
 */
import fs from 'node:fs';

export const DENY_REASON =
  'Searching code with grep, rg, find or cat is disabled in this session. Use the gsd-atlas MCP tools instead: ' +
  'mcp__gsd-atlas__code_refs (who calls or refers to a symbol), mcp__gsd-atlas__code_impact (what depends on a symbol), ' +
  'mcp__gsd-atlas__code_find (where a symbol is defined) and mcp__gsd-atlas__code_context (a symbol with its file, imports, exports and compiled output path). ' +
  'Use the Read tool to open a file.';

const BLOCKED = new Set(['grep', 'egrep', 'fgrep', 'rg', 'find', 'cat']);

/** The program name of each simple command in a shell line, looking inside `$(...)` and backticks too. */
function programs(command: string): string[] {
  const segments = command.split(/&&|\|\||[|;&\n]|\$\(|\)|`/);
  const out: string[] = [];
  for (const segment of segments) {
    const words = segment.trim().split(/\s+/).filter((w) => w !== '');
    // Skip leading VAR=value assignments.
    let i = 0;
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i] ?? '')) i += 1;
    const first = words[i];
    if (first === undefined) continue;
    const name = first.split('/').at(-1) ?? first;
    out.push(name === 'git' && words[i + 1] === 'grep' ? 'grep' : name);
  }
  return out;
}

export type Decision = { deny: false } | { deny: true; reason: string };

export function decide(command: string): Decision {
  return programs(command).some((p) => BLOCKED.has(p)) ? { deny: true, reason: DENY_REASON } : { deny: false };
}

/** The `--settings` JSON: `base` (a JSON object string) plus the Bash PreToolUse hook that runs `scriptPath`. */
export function hookSettings(base: string, scriptPath: string): string {
  const parsed = JSON.parse(base) as Record<string, unknown>;
  return JSON.stringify({
    ...parsed,
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `node ${scriptPath}` }] }] },
  });
}

function main(): void {
  let payload: { tool_name?: unknown; tool_input?: { command?: unknown } };
  try {
    payload = JSON.parse(fs.readFileSync(0, 'utf8')) as typeof payload;
  } catch {
    return;
  }
  const command = payload.tool_input?.command;
  if (payload.tool_name !== 'Bash' || typeof command !== 'string') return;
  const decision = decide(command);
  if (!decision.deny) return;
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: decision.reason } }),
  );
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) main();
