import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, it } from 'node:test';

import { decide, hookSettings } from './route-hook.ts';

describe('decide', () => {
  for (const command of ['grep -rn foo src', 'rg foo', 'git grep -n foo', 'find . -name "*.cts"', 'cat src/a.cts', 'ls src | grep a', 'cd x && rg y', 'FOO=1 grep x f', 'echo $(cat a)']) {
    it(`denies ${command}`, () => assert.equal(decide(command).deny, true));
  }
  for (const command of ['ls src', 'head -20 src/a.cts', 'wc -l src/a.cts', 'git ls-files src', 'sort a | uniq', 'tail -5 f']) {
    it(`allows ${command}`, () => assert.equal(decide(command).deny, false));
  }
  it('names the atlas tools in the reason', () => {
    const d = decide('grep x y');
    assert.equal(d.deny, true);
    if (d.deny) assert.match(d.reason, /mcp__gsd-atlas__code_refs/);
  });
});

describe('hook process', () => {
  const script = path.resolve(import.meta.dirname, 'route-hook.ts');
  const run = (command: string) =>
    spawnSync(process.execPath, [script], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }), encoding: 'utf8' });
  it('prints a PreToolUse deny decision as JSON and exits 0', () => {
    const r = run('grep -rn x .');
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout) as { hookSpecificOutput: { hookEventName: string; permissionDecision: string; permissionDecisionReason: string } };
    assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
    assert.ok(out.hookSpecificOutput.permissionDecisionReason.length > 20);
  });
  it('prints nothing and exits 0 for an allowed command', () => {
    const r = run('ls');
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  });
});

describe('hookSettings', () => {
  it('merges the hook into the given settings JSON for the Bash matcher', () => {
    const merged = JSON.parse(hookSettings('{"disableBundledSkills":true}', '/x/route-hook.ts')) as {
      disableBundledSkills: boolean;
      hooks: { PreToolUse: { matcher: string; hooks: { type: string; command: string }[] }[] };
    };
    assert.equal(merged.disableBundledSkills, true);
    assert.equal(merged.hooks.PreToolUse[0]?.matcher, 'Bash');
    assert.match(merged.hooks.PreToolUse[0]?.hooks[0]?.command ?? '', /route-hook\.ts/);
  });
});
