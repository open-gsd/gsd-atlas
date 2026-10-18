// A stand-in for the `claude` executable, driven by tests through process.execPath.
// The mode comes from FAKE_CLAUDE_MODE; FAKE_CLAUDE_TAG is appended to the result text so
// concurrent sessions can be told apart. The prompt is read from stdin to the end first,
// like the real program in print mode, and its byte length is echoed back in the result
// event (fake_stdin_length) together with the argv the child received (fake_argv).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { once } from 'node:events';

const dir = import.meta.dirname;
const mode = process.env.FAKE_CLAUDE_MODE ?? 'ok';
const tag = process.env.FAKE_CLAUDE_TAG ?? '';

const fixtureLines = (name) =>
  readFileSync(join(dir, name), 'utf8')
    .split('\n')
    .filter((line) => line.length > 0);

let stdinLength = 0;
for await (const chunk of process.stdin) stdinLength += chunk.length;

// Rewrite the recorded result line so the test can see what the child received.
const withEcho = (line, patch = {}) => {
  const event = JSON.parse(line);
  if (event.type !== 'result') return line;
  event.result = `${event.result ?? ''}${tag}`;
  event.fake_stdin_length = stdinLength;
  event.fake_argv = process.argv.slice(2);
  return JSON.stringify({ ...event, ...patch });
};

const emit = (lines, patch) => {
  for (const line of lines) process.stdout.write(`${withEcho(line, patch)}\n`);
};

const stream = fixtureLines('claude-stream-ok.jsonl');
const initLine = stream[0];

switch (mode) {
  case 'ok':
    emit(stream);
    break;
  case 'tools':
    emit(fixtureLines('claude-stream-tools.jsonl'));
    break;
  case 'costly':
    emit(stream, { total_cost_usd: 99 });
    break;
  case 'slow':
    process.stdout.write(`${initLine}\n`);
    setInterval(() => {}, 1000);
    break;
  case 'huge': {
    process.stdout.write(`${initLine}\n`);
    const filler = JSON.stringify({
      type: 'assistant',
      message: { id: 'MSG-HUGE', content: [{ type: 'text', text: 'x'.repeat(16 * 1024) }] },
    });
    for (let i = 0; i < 512; i += 1) {
      if (!process.stdout.write(`${filler}\n`)) await once(process.stdout, 'drain');
    }
    break;
  }
  case 'partial':
    process.stdout.write(`${initLine}\n`);
    process.stdout.write('this line is not json\n');
    process.stdout.write(`${JSON.stringify({ type: 'mystery_event', payload: 1 })}\n`);
    process.stdout.write(`${stream[1]}\n`);
    process.stdout.write('{"type":"assistant","message":{"content":[{"type":"te'); // cut mid-line
    break;
  case 'error':
    process.stderr.write(`${'x'.repeat(4000)}END-OF-STDERR`);
    process.exitCode = 3;
    break;
  case 'error-result':
    emit(stream, { is_error: true, subtype: 'error_during_execution' });
    process.exitCode = 1;
    break;
  case 'budget':
    emit(stream, { is_error: true, subtype: 'error_max_budget_usd' });
    process.exitCode = 1;
    break;
  default:
    process.stderr.write(`unknown FAKE_CLAUDE_MODE: ${mode}\n`);
    process.exitCode = 2;
}
