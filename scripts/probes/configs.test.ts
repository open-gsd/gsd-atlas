import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildClaudeArgs } from '../eval/claude-session.ts';
import { CONFIG_IDS, planFor, scrubbedEnv } from './configs.ts';
import type { PlanContext } from './configs.ts';

const ctx: PlanContext = {
  mcpConfigPath: '/s/mcp.json',
  pluginDir: '/s/plugin',
  hookScript: '/s/route-hook.ts',
  answerSchema: '{"type":"object"}',
  model: 'claude-sonnet-5-5',
  maxBudgetUsd: 0.25,
  wallClockMs: 60000,
};

const argsOf = (id: (typeof CONFIG_IDS)[number]): string[] => {
  const plan = planFor(id, ctx);
  return [...plan.prefixArgs, ...buildClaudeArgs({ prompt: 'p', cwd: '/c', ...plan.spec })];
};

describe('planFor', () => {
  it('grep: Bash and Read only, no plugin, no settings, no atlas tool', () => {
    const plan = planFor('grep', ctx);
    assert.deepEqual(plan.spec.tools, ['Bash', 'Read']);
    assert.deepEqual(plan.spec.pluginDirs, []);
    assert.equal(plan.spec.settings, undefined);
    assert.equal(plan.atlas, false);
    assert.ok(!plan.spec.allowedTools.some((t) => t.startsWith('mcp__')));
  });

  it('atlas: the registered tools, plugin and settings, seven atlas tools', () => {
    const plan = planFor('atlas', ctx);
    assert.deepEqual(plan.spec.tools, ['Bash', 'Read', 'Skill']);
    assert.deepEqual(plan.spec.pluginDirs, ['/s/plugin']);
    assert.match(plan.spec.settings ?? '', /disableBundledSkills/);
    assert.equal(plan.spec.allowedTools.filter((t) => t.startsWith('mcp__gsd-atlas__')).length, 7);
    assert.ok(plan.spec.allowedTools.includes('Skill(gsd-atlas-eval:gsd-atlas)'));
  });

  it('atlas-noskill: no Skill tool, no plugin, no Skill allow rule', () => {
    const plan = planFor('atlas-noskill', ctx);
    assert.deepEqual(plan.spec.tools, ['Bash', 'Read']);
    assert.deepEqual(plan.spec.pluginDirs, []);
    assert.ok(!plan.spec.allowedTools.some((t) => t.startsWith('Skill')));
    assert.equal(plan.spec.allowedTools.filter((t) => t.startsWith('mcp__gsd-atlas__')).length, 7);
  });

  it('atlas-3tools-deny restricts with --disallowedTools and keeps the server unpatched', () => {
    const args = argsOf('atlas-3tools-deny');
    const i = args.indexOf('--disallowedTools');
    assert.ok(i >= 0);
    assert.match(args[i + 1] ?? '', /code_context/);
    assert.match(args[i + 1] ?? '', /atlas_status/);
    assert.doesNotMatch(args[i + 1] ?? '', /code_find/);
    assert.equal(planFor('atlas-3tools-deny', ctx).serverPatch, undefined);
  });

  it('atlas-3tools uses a patched server with exactly three tools', () => {
    const plan = planFor('atlas-3tools', ctx);
    assert.deepEqual(plan.serverPatch?.tools, ['code_find', 'code_refs', 'code_impact']);
    assert.equal(plan.spec.allowedTools.filter((t) => t.startsWith('mcp__gsd-atlas__')).length, 3);
  });

  it('atlas-noinstr patches the instructions out', () => {
    assert.equal(planFor('atlas-noinstr', ctx).serverPatch?.instructions, false);
  });

  it('atlas-ts adds ToolSearch to --tools; atlas-ts-env also sets ENABLE_TOOL_SEARCH on the child only', () => {
    assert.ok(planFor('atlas-ts', ctx).spec.tools.includes('ToolSearch'));
    assert.equal(planFor('atlas-ts', ctx).spec.env?.['ENABLE_TOOL_SEARCH'], undefined);
    assert.equal(planFor('atlas-ts-env', ctx).spec.env?.['ENABLE_TOOL_SEARCH'], 'true');
  });

  it('atlas-routed passes the hook through --settings, merged with the registered settings', () => {
    const settings = planFor('atlas-routed', ctx).spec.settings ?? '';
    const parsed = JSON.parse(settings) as { disableBundledSkills: boolean; hooks: unknown };
    assert.equal(parsed.disableBundledSkills, true);
    assert.ok(parsed.hooks);
  });

  it('atlas-routed-ts combines the routing hook with tool search', () => {
    const plan = planFor('atlas-routed-ts', ctx);
    assert.ok(plan.spec.tools.includes('ToolSearch'));
    assert.ok(plan.spec.allowedTools.includes('ToolSearch'));
    assert.ok(JSON.parse(plan.spec.settings ?? '{}').hooks);
  });

  it('atlas-capped patches a default budget', () => {
    assert.equal(typeof planFor('atlas-capped', ctx).serverPatch?.budgetTokens, 'number');
  });

  it('every config keeps the registered isolation flags', () => {
    for (const id of CONFIG_IDS) {
      const args = argsOf(id);
      assert.ok(args.includes('--strict-mcp-config'), id);
      assert.equal(args[args.indexOf('--setting-sources') + 1], '', id);
      assert.ok(args.includes('--no-session-persistence'), id);
      assert.ok(args.includes('--json-schema'), id);
    }
  });
});

describe('scrubbedEnv', () => {
  it('drops every ANTHROPIC and CLAUDE variable and keeps the rest', () => {
    const out = scrubbedEnv({ PATH: '/bin', HOME: '/h', ANTHROPIC_API_KEY: 'x', CLAUDE_CODE_FOO: 'y', CLAUDECODE: '1', CLAUDE_EFFORT: 'z', ENABLE_TOOL_SEARCH: 'false', OTHER: '1' });
    assert.deepEqual(Object.keys(out).sort(), ['HOME', 'OTHER', 'PATH']);
  });
});
