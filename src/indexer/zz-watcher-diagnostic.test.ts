/**
 * TEMPORARY evidence-gathering test for plan 02-26 (removed in the next commit): prints what the native watcher delivers
 * for a linked worktree's HEAD in the common git directory, under four sequences, on every operating system. It asserts
 * nothing, so it cannot change a CI result; the output lines start with DIAG.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { allowAll, createRealRunner } from '../command-runner/index.ts';
import { createTempGitRepo, realPath } from '../test-kit/index.ts';
import type { TempGitRepo } from '../test-kit/index.ts';

const GIT_IGNORE = ['objects', 'logs', '**/logs', 'hooks', 'info', '**/*.lock'];

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const say = (line: string): void => {
  process.stdout.write(`DIAG ${line}\n`);
};

interface Watcher {
  subscribe(dir: string, fn: (error: Error | null, events: Array<{ path: string; type: string }>) => void, options?: { ignore?: string[] }): Promise<{ unsubscribe(): Promise<void> }>;
}

async function scenario(label: string, options: { ignore: boolean; preexisting: boolean; gapMs: number }): Promise<void> {
  const watcher = ((await import('@parcel/watcher')) as unknown as { default?: Watcher } & Watcher).default ?? ((await import('@parcel/watcher')) as unknown as Watcher);
  const repo: TempGitRepo = await createTempGitRepo({
    runner: createRealRunner({ decide: allowAll }),
    world: { committed: { 'a.txt': 'one\n' } },
  });
  try {
    const common = realPath(path.join(repo.dir, '.git'));
    const parent = path.dirname(repo.dir);
    if (options.preexisting) await repo.git(['worktree', 'add', '--quiet', '-b', 'first', path.join(parent, 'first-wt')]);
    const began = performance.now();
    const events: string[] = [];
    const subscription = await watcher.subscribe(
      common,
      (error, batch) => {
        const at = (performance.now() - began).toFixed(0);
        if (error !== null) events.push(`${at}ms ERROR ${error.message}`);
        for (const event of batch) events.push(`${at}ms ${event.type} ${path.relative(common, event.path).split(path.sep).join('/')}`);
      },
      options.ignore ? { ignore: GIT_IGNORE } : {},
    );
    await sleep(300);
    const linked = path.join(parent, 'linked-wt');
    events.push(`${(performance.now() - began).toFixed(0)}ms -- git worktree add`);
    await repo.git(['worktree', 'add', '--quiet', '-b', 'side', linked]);
    await sleep(options.gapMs);
    events.push(`${(performance.now() - began).toFixed(0)}ms -- git checkout -b side-two (linked)`);
    await repo.git(['-C', linked, 'checkout', '--quiet', '-b', 'side-two']);
    await sleep(2500);
    events.push(`${(performance.now() - began).toFixed(0)}ms -- second checkout (linked)`);
    await repo.git(['-C', linked, 'checkout', '--quiet', '-b', 'side-three']);
    await sleep(2500);
    await subscription.unsubscribe();
    const headEvents = events.filter((line) => /worktrees\/linked-wt\/HEAD$/.test(line)).length;
    say(`${label}: ignore=${String(options.ignore)} preexisting=${String(options.preexisting)} gap=${String(options.gapMs)}ms -> ${String(headEvents)} events for worktrees/linked-wt/HEAD`);
    for (const line of events.filter((entry) => !/\/logs\//.test(entry))) say(`  ${line}`);
  } finally {
    repo.cleanup();
  }
}

describe('DIAG native watcher and a linked worktree HEAD', () => {
  it('prints the platform', () => {
    let watches = 'n/a';
    try {
      watches = fs.readFileSync('/proc/sys/fs/inotify/max_user_watches', 'utf8').trim();
    } catch {
      // not Linux
    }
    say(`platform ${process.platform}-${process.arch} node ${process.versions.node} inotify max_user_watches ${watches}`);
  });
  it('S1: as the production source does (ignore list, first worktree, short gap)', { timeout: 60_000 }, async () => {
    await scenario('S1', { ignore: true, preexisting: false, gapMs: 200 });
  });
  it('S2: no ignore list', { timeout: 60_000 }, async () => {
    await scenario('S2', { ignore: false, preexisting: false, gapMs: 200 });
  });
  it('S3: the worktrees directory already exists before the subscription', { timeout: 60_000 }, async () => {
    await scenario('S3', { ignore: true, preexisting: true, gapMs: 200 });
  });
  it('S4: a long gap between the add and the checkout', { timeout: 60_000 }, async () => {
    await scenario('S4', { ignore: true, preexisting: false, gapMs: 3000 });
  });
});
