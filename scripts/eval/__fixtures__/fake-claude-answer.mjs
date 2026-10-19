// A stand-in for the `claude` executable used by the harness tests (plan 03-10). It reads the
// prompt on stdin to the end, prints a stream-json session and exits. Unlike fake-claude.mjs
// (which replays recorded streams for the session-module tests) this one builds its `system/init`
// event from the arguments it was given, so a test sees exactly what the harness asked for:
// the built-in tools from `--tools`, the MCP servers from the `--mcp-config` file, and the skills
// from each `--plugin-dir`.
//
// Environment (all optional):
//   FAKE_ANSWER_MODE       perfect | wrong | not_found | garbage | timeout | ratelimit |
//                          ratelimit-after-tool (default perfect)
//   FAKE_FAIL_FIRST        n: with FAKE_COUNTER_FILE, the first n invocations are rate limited
//   FAKE_INIT_EXTRA_TOOLS  JSON array of tool names added to the init event (contamination)
//   FAKE_INIT_EXTRA_SERVERS JSON array of MCP server names added to the init event
//   FAKE_NO_INIT           "1": print no init event
//   FAKE_ANSWERS_FILE      JSON object: question text -> the answer object a perfect session gives
//   FAKE_TOOL_NAMES        JSON array of tool names to call before answering (default ["Bash"])
//   FAKE_DELAY_MS          sleep before the result, to give concurrency tests something to overlap
//   FAKE_EVENTS_FILE       JSON line appended at start and at end (pid, timestamp, cwd)
//   FAKE_LOCK_SESSION      "1": make a directory of the session read-only, so cleanup fails
import { appendFileSync, chmodSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const env = process.env;
const mode = env.FAKE_ANSWER_MODE ?? 'perfect';
const argv = process.argv.slice(2);

process.stdin.setEncoding('utf8');
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;

const flag = (name) => {
  const at = argv.indexOf(name);
  return at < 0 ? undefined : argv[at + 1];
};
const flags = (name) => argv.flatMap((a, i) => (a === name ? [argv[i + 1]] : []));
const events = env.FAKE_EVENTS_FILE;
const note = (kind) => {
  if (events !== undefined) {
    appendFileSync(events, `${JSON.stringify({ kind, pid: process.pid, ts: Date.now(), cwd: process.cwd() })}\n`);
  }
};
note('start');

// ---- the init event, derived from the arguments ------------------------------------------------
const tools = (flag('--tools') ?? '').split(',').filter((t) => t !== '');
const servers = [];
const mcpConfigPath = flag('--mcp-config');
if (mcpConfigPath !== undefined && existsSync(mcpConfigPath)) {
  const config = JSON.parse(readFileSync(mcpConfigPath, 'utf8'));
  for (const name of Object.keys(config.mcpServers ?? {})) {
    servers.push(name);
    // A connected atlas server exposes tools named mcp__<server>__<tool>.
    if (name === 'gsd-atlas') {
      for (const t of ['code_find', 'code_refs', 'code_context']) tools.push(`mcp__${name}__${t}`);
    }
  }
}
// Claude Code's own skills. The `--settings` JSON with `disableBundledSkills` removes them (the atlas arm's settings).
const settingsJson = flag('--settings');
const bundledOff = settingsJson !== undefined && JSON.parse(settingsJson).disableBundledSkills === true;
const skills = bundledOff ? [] : ['update-config', 'debug'];
for (const dir of flags('--plugin-dir')) {
  const plugin = JSON.parse(readFileSync(join(dir, '.claude-plugin', 'plugin.json'), 'utf8'));
  const skillsDir = join(dir, 'skills');
  if (existsSync(skillsDir)) for (const s of readdirSync(skillsDir)) skills.push(`${plugin.name}:${s}`);
}
for (const t of JSON.parse(env.FAKE_INIT_EXTRA_TOOLS ?? '[]')) tools.push(t);
for (const s of JSON.parse(env.FAKE_INIT_EXTRA_SERVERS ?? '[]')) servers.push(s);

const out = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
if (env.FAKE_NO_INIT !== '1') {
  out({
    type: 'system',
    subtype: 'init',
    cwd: process.cwd(),
    session_id: 'FAKE-SESSION',
    tools,
    mcp_servers: servers.map((name) => ({ name, status: 'connected' })),
    model: flag('--model') ?? 'fake-model',
    skills,
    plugins: [],
    agents: [],
  });
}

if (env.FAKE_LOCK_SESSION === '1') {
  // Make a directory of the checkout read-only so that removing the session directory fails.
  chmodSync(join(process.cwd(), 'src'), 0o555);
}

// ---- the mode of this invocation ---------------------------------------------------------------
// FAKE_FAIL_FIRST=n with FAKE_COUNTER_FILE: the first n invocations are rate limited, later ones
// follow FAKE_ANSWER_MODE.
let effective = mode;
if (env.FAKE_FAIL_FIRST !== undefined && env.FAKE_COUNTER_FILE !== undefined) {
  appendFileSync(env.FAKE_COUNTER_FILE, '1\n');
  const seen = readFileSync(env.FAKE_COUNTER_FILE, 'utf8').split('\n').filter((line) => line !== '').length;
  if (seen <= Number(env.FAKE_FAIL_FIRST)) effective = 'ratelimit';
}
const RATE_LIMIT_TEXT = 'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Rate limit reached"}}';

// ---- tool calls --------------------------------------------------------------------------------
const toolNames = JSON.parse(env.FAKE_TOOL_NAMES ?? '["Bash"]');
const usage = { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 30, cache_read_input_tokens: 40 };
const emitToolCalls = () => {
  toolNames.forEach((name, i) => {
    out({
      type: 'assistant',
      message: {
        id: `MSG-${String(i + 1)}`,
        role: 'assistant',
        content: [{ type: 'tool_use', id: `TOOLUSE-${String(i + 1)}`, name, input: {} }],
        usage: { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 4 },
      },
    });
  });
};

if (effective === 'timeout') {
  emitToolCalls();
  setInterval(() => {}, 1000); // never answers; the harness kills it at the wall-clock bound
} else if (effective === 'ratelimit' || effective === 'ratelimit-after-tool') {
  // The API refused the request. `ratelimit` makes no tool call first; `ratelimit-after-tool` does.
  if (effective === 'ratelimit-after-tool') emitToolCalls();
  out({
    type: 'result',
    subtype: 'success',
    is_error: true,
    api_error_status: 429,
    result: RATE_LIMIT_TEXT,
    usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    total_cost_usd: 0,
    num_turns: 1,
    duration_ms: 1,
    fake_argv: argv,
  });
  process.exitCode = 1;
} else {
  emitToolCalls();
  const delay = Number(env.FAKE_DELAY_MS ?? 0);
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));

  let text;
  if (effective === 'garbage') {
    text = 'I could not work out the answer, sorry.';
  } else if (effective === 'not_found') {
    text = JSON.stringify({ answer: 'not_found', items: [], summary: 'nothing found' });
  } else if (effective === 'wrong') {
    text = JSON.stringify({ answer: 'found', items: [{ file: 'src/nowhere.cts', line: 1 }], summary: 'wrong place' });
  } else {
    const answers = env.FAKE_ANSWERS_FILE === undefined ? {} : JSON.parse(readFileSync(env.FAKE_ANSWERS_FILE, 'utf8'));
    const match = Object.keys(answers).find((question) => prompt.includes(question));
    text = JSON.stringify(match === undefined ? { answer: 'not_found', items: [], summary: 'no scripted answer' } : answers[match]);
  }
  out({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: text,
    usage,
    total_cost_usd: 0.01,
    num_turns: toolNames.length + 1,
    duration_ms: 5,
    // Echoes for the tests: what the child actually received.
    fake_prompt: prompt,
    fake_argv: argv,
    fake_cwd: process.cwd(),
    fake_env: { store: env.GSD_ATLAS_STORE_DIR ?? null, user: env.GSD_ATLAS_USER_DIR ?? null },
  });
}
note('end');
