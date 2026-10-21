import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { surveyDirectory } from './survey.ts';

function write(root: string, rel: string, text: string): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text);
}

test('surveyDirectory measures a small synthetic tree', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-survey-'));
  try {
    write(root, 'LICENSE', 'MIT License\n\nPermission is hereby granted, free of charge, to any person');
    write(root, 'CLAUDE.md', '# agent file\n');
    write(root, 'package.json', JSON.stringify({ name: 'root-pkg', workspaces: ['packages/*'] }));
    write(root, 'packages/lib/package.json', JSON.stringify({ name: '@s/lib' }));
    write(root, 'tsconfig.json', JSON.stringify({ compilerOptions: { module: 'esnext', moduleResolution: 'bundler', paths: { '@s/lib': ['./packages/lib/src/index.ts'] } } }));
    write(root, 'packages/lib/src/index.ts', "export * from './a';\n");
    write(root, 'packages/lib/src/a.ts', 'export function shared() {}\nexport function onlyA() {}\n');
    write(root, 'src/b.ts', "import { shared } from '@s/lib';\nimport x from 'external-pkg';\nimport { y } from './missing';\nexport function shared() { return shared; }\n");
    write(root, 'src/b.test.ts', "export function shared() {}\n");
    const r = await surveyDirectory(root, { name: 'fixture', seed: 'seed', maxFiles: 100, maxNames: 10, grepSample: 5 });
    assert.equal(r.license.spdx, 'MIT');
    assert.deepEqual(r.agentConfigs, ['CLAUDE.md']);
    assert.equal(r.tsconfig.count, 1);
    assert.equal(r.tsconfig.withPaths, 1);
    assert.equal(r.tsJs.files, 4);
    assert.equal(r.tsJs.testFiles, 1);
    assert.equal(r.sample.files, 3);
    assert.equal(r.sample.names.distinctNames, 2);
    assert.equal(r.sample.names.multiFileNames, 1);
    assert.equal(r.sample.barrelFiles, 1);
    assert.equal(r.resolution.relative.total, 2);
    assert.equal(r.resolution.relative.resolved, 1);
    assert.equal(r.resolution.workspace.total, 1);
    assert.equal(r.resolution.workspace.resolved, 1);
    assert.equal(r.resolution.external.total, 1);
    assert.ok(r.grep.names >= 1);
    assert.ok(r.grep.filesMedian >= 1);
    assert.equal(r.grepAmbiguous.names, 1);
    assert.ok(r.grepAmbiguous.filesMedian >= 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
