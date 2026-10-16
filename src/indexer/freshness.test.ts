/**
 * IDX-01 with everything real: the native file watcher, the real Fact Store, the real Grammar Engine with the
 * shipped TypeScript module, the real Governor and the real clock. A save must reach `find` within the PR-job
 * ceiling; the strict 1 second figure is checked by the gate script of plan 02-26, not here (hosted CI timing is
 * noisy).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createRealRunner } from '../command-runner/index.ts';
import { openFactStore } from '../fact-store/index.ts';
import { systemClock } from '../facts/index.ts';
import { createGovernor } from '../governor/index.ts';
import { createGrammarEngine } from '../grammar-engine/index.ts';
import { createSourceTree } from '../source-tree/index.ts';
import { createTempGitRepo, makeTempDir } from '../test-kit/index.ts';
import { createIndexer } from './index.ts';
import { noResolver, setupRunner, shippedModules } from './harness.test.ts';
import { createParcelEventSource } from './parcel-source.ts';

/** `gate.freshnessPrCeilingMs` in .planning/phases/02-grammar-tier-store-and-stdio-host/02-CONSTANTS.md (Approved). */
const FRESHNESS_PR_CEILING_MS = 3000;

/** Room for set-up and tear-down on a slow runner, on top of the ceiling itself. */
const TEST_TIMEOUT_MS = FRESHNESS_PR_CEILING_MS + 30000;

describe('IDX-01: a saved file is found within the approved ceiling, with the real watcher', () => {
  it(
    'find returns the new definition after a save, and saving identical content again leaves the watermark alone',
    { timeout: TEST_TIMEOUT_MS },
    async (t) => {
      const repo = await createTempGitRepo({
        runner: setupRunner,
        world: {
          committed: {
            'src/a.ts': 'export function original(): number {\n  return 1;\n}\n',
            'src/other.ts': 'export const other = 2;\n',
          },
        },
      });
      const tmp = makeTempDir();
      const store = await openFactStore(
        path.join(tmp.path, 'store'),
        { resolver: noResolver, clock: systemClock, gitHas: () => Promise.resolve(true) },
        { repo: 'fresh', version: 'test' },
      );
      const engine = createGrammarEngine();
      const indexer = createIndexer({
        tenant: 'fresh',
        tree: createSourceTree({ runner: createRealRunner(), repoDir: repo.dir, envOverlay: repo.envOverlay }),
        store,
        engine,
        roots: { repoRoot: repo.dir, userDir: path.join(tmp.path, 'user'), builtinDir: shippedModules, npmRoots: [] },
        governor: createGovernor({ clock: systemClock }),
        clock: systemClock,
        source: createParcelEventSource(),
      });
      t.after(async () => {
        await indexer.stop();
        await engine.dispose();
        await store.close();
        tmp.cleanup();
        repo.cleanup();
      });

      await indexer.start();
      const reader = store.at(repo.dir);
      assert.equal(indexer.status().watchMode, 'native');
      assert.equal((await reader.find('original')).data.length, 1, 'the start-up Reconcile indexed the repository');

      const saved = 'export function original(): number {\n  return 1;\n}\nexport function freshly_saved_one(): number {\n  return 2;\n}\n';
      const savedAt = performance.now();
      fs.writeFileSync(path.join(repo.dir, 'src', 'a.ts'), saved);
      let found = false;
      while (!found && performance.now() - savedAt < FRESHNESS_PR_CEILING_MS + 5000) {
        found = (await reader.find('freshly_saved_one')).data.length === 1;
        if (!found) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const elapsedMs = Math.round(performance.now() - savedAt);
      t.diagnostic(`freshness: a save reached find in ${String(elapsedMs)} ms (PR ceiling ${String(FRESHNESS_PR_CEILING_MS)} ms)`);
      assert.ok(found, 'the new definition was never returned');
      assert.ok(elapsedMs <= FRESHNESS_PR_CEILING_MS, `${String(elapsedMs)} ms is over the ${String(FRESHNESS_PR_CEILING_MS)} ms ceiling`);

      // Saving identical content again, and touching the file, must create no new commit.
      const seq = (await reader.find('freshly_saved_one')).watermark.seq;
      fs.writeFileSync(path.join(repo.dir, 'src', 'a.ts'), saved);
      const touched = new Date(Date.now() + 1000);
      fs.utimesSync(path.join(repo.dir, 'src', 'a.ts'), touched, touched);
      await new Promise((resolve) => setTimeout(resolve, 900));
      const status = indexer.status();
      assert.equal(status.queued, 0);
      assert.equal(status.running, 0);
      assert.equal((await reader.find('freshly_saved_one')).watermark.seq, seq, 'identical content moves no watermark');
    },
  );
});
