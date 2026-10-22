import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { assertClean, manifestHash, prepareCheckout, shouldStrip } from './prepare-checkout.ts';

describe('shouldStrip', () => {
  it('strips agent-config files and directories at any depth, and the root skills directory only', () => {
    for (const p of [
      'AGENTS.md',
      'packages/compiler-cli/preprocessor/AGENTS.md',
      'adev/src/context/GEMINI.md',
      'CLAUDE.md',
      'docs/claude.md',
      '.agent/rules/a.md',
      '.gemini/settings.json',
      '.claude/settings.json',
      '.cursor/rules/x.mdc',
      'nested/.agent/skills/x/SKILL.md',
      'skills/angular-developer/SKILL.md',
      '.mcp.json',
      'context7.json',
      'adev/src/llms.txt',
      'adev/src/llms-full.txt',
    ]) {
      assert.equal(shouldStrip(p).strip, true, p);
    }
    for (const p of ['packages/core/src/a.ts', 'packages/skills/keep.ts', 'README.md', 'docs/agents-overview.md', 'packages/core/llms.ts', 'adev/src/llms.ts']) {
      assert.equal(shouldStrip(p).strip, false, p);
    }
  });
});

function run(cwd: string, args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function fixtureRepo(root: string): { repo: string; sha: string } {
  const repo = path.join(root, 'src-repo');
  const files: Record<string, string> = {
    'AGENTS.md': 'rules',
    'GEMINI.md': 'gemini',
    '.agent/rules/a.md': 'a',
    '.gemini/s.md': 's',
    'skills/x/SKILL.md': 'skill',
    'packages/skills/keep.ts': 'export const keep = 1;\n',
    'packages/core/AGENTS.md': 'nested',
    'context7.json': '{}',
    'adev/src/llms.txt': 'llms',
    'adev/src/llms-full.txt': 'llms',
    'packages/core/a.ts': 'export const a = 1;\n',
    'README.md': 'hello',
  };
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), text);
  }
  run(repo, ['init', '-q', '-b', 'main']);
  run(repo, ['add', '-A']);
  run(repo, ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'fixture']);
  return { repo, sha: run(repo, ['rev-parse', 'HEAD']) };
}

describe('prepareCheckout', () => {
  it('exports the pinned tree, strips the list, records what was stripped and a manifest hash, and commits a clean tree', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prep-checkout-'));
    try {
      fs.mkdirSync(path.join(root, 'src-repo'));
      const { repo, sha } = fixtureRepo(root);
      const a = prepareCheckout({ repo, sha, dest: path.join(root, 'out-a'), scratch: path.join(root, 'tmp-a') });
      assert.deepEqual(a.strippedPaths, [
        '.agent/rules/a.md',
        '.gemini/s.md',
        'AGENTS.md',
        'GEMINI.md',
        'adev/src/llms-full.txt',
        'adev/src/llms.txt',
        'context7.json',
        'packages/core/AGENTS.md',
        'skills/x/SKILL.md',
      ]);
      assert.equal(a.sha, sha);
      assert.equal(a.treeFileCount, 12);
      assert.equal(a.fileCount, 3);
      assert.match(a.manifestSha256, /^[0-9a-f]{64}$/);
      assert.deepEqual(fs.readdirSync(path.join(root, 'out-a')).sort(), ['.git', 'README.md', 'packages']);
      assert.equal(run(path.join(root, 'out-a'), ['rev-list', '--count', 'HEAD']), '1');
      assert.equal(run(path.join(root, 'out-a'), ['status', '--short']), '');
      // deterministic: same tree, same manifest hash, wherever it is prepared
      const b = prepareCheckout({ repo, sha, dest: path.join(root, 'out-b'), scratch: path.join(root, 'tmp-b') });
      assert.equal(b.manifestSha256, a.manifestSha256);
      assert.equal(manifestHash(path.join(root, 'out-b')), a.manifestSha256);
      assertClean(path.join(root, 'out-a'));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a destination that is not empty and a tree that still holds agent config', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prep-checkout-'));
    try {
      fs.mkdirSync(path.join(root, 'src-repo'));
      const { repo, sha } = fixtureRepo(root);
      fs.mkdirSync(path.join(root, 'full'));
      fs.writeFileSync(path.join(root, 'full', 'x'), '1');
      assert.throws(() => prepareCheckout({ repo, sha, dest: path.join(root, 'full'), scratch: path.join(root, 'tmp') }), /not empty/);
      const dirty = path.join(root, 'dirty');
      fs.mkdirSync(path.join(dirty, '.claude'), { recursive: true });
      assert.throws(() => assertClean(dirty), /\.claude/);
      fs.rmSync(path.join(dirty, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(dirty, 'AGENTS.md'), 'x');
      assert.throws(() => assertClean(dirty), /AGENTS\.md/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
