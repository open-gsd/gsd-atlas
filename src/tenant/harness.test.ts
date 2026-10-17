/**
 * Test helper for the Tenant tests (no test inside it): a real temporary git repository per world, the real runner,
 * the real in-process Grammar Engine and Governor, a manual event source, and the doubles the 02-28 tests need: a
 * clock that counts its live timers, a scripted Indexer whose start can be held back, and a recording Metrics.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { TestContext } from 'node:test';
import { allowAll, createRealRunner } from '../command-runner/index.ts';
import { openFactStore } from '../fact-store/index.ts';
import type { FactStore } from '../fact-store/index.ts';
import { PROTOCOL_VERSION, systemClock } from '../facts/index.ts';
import type { Clock, Envelope, Request } from '../facts/index.ts';
import { createGovernor } from '../governor/index.ts';
import type { Governor } from '../governor/index.ts';
import { createGrammarEngine } from '../grammar-engine/index.ts';
import { createManualEventSource } from '../indexer/index.ts';
import type { FailedPath, Indexer, IndexerDeps, IndexerStatus, ManualEventSource } from '../indexer/index.ts';
import { createNoopMetrics } from '../metrics/index.ts';
import type { Metrics, MetricsEvent } from '../metrics/index.ts';
import { createSourceTree } from '../source-tree/index.ts';
import { createTempGitRepo, makeTempDir } from '../test-kit/index.ts';
import type { TempDir, TempGitRepo } from '../test-kit/index.ts';
import { createTenant } from './index.ts';
import type { Tenant, TenantDeps } from './index.ts';

export const toyModules = path.resolve(import.meta.dirname, '..', '..', 'test', 'fixtures', 'modules');

/** Setup commands (init, add, commit) are not in the production allowlist, so setup uses the allow-all rule. */
export const setupRunner = createRealRunner({ decide: allowAll });

export const THREE_FILES: Readonly<Record<string, string>> = {
  'a.toy': 'fn main {\n  boot();\n}\nfn boot {\n}\n',
  'b.toy': 'fn helper {\n}\n',
  'c.toy': 'type Widget {\n}\n',
  'README.md': '# toy repository\n',
};

/** Poll until `check` holds; the work behind it runs on real I/O. */
export async function eventually(check: () => boolean | Promise<boolean>, what: string, timeoutMs = 10000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** A few turns of the event loop, for work that is already in flight and has nothing to wait for. */
export async function settle(turns = 5): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) await new Promise((resolve) => setImmediate(resolve));
}

export const request = (kind: string, args: Record<string, unknown>, extra: Partial<Request> = {}): Request => ({
  protocol: PROTOCOL_VERSION,
  kind,
  args,
  ...extra,
});

export const find = (name: string, repo: string, extra: Partial<Request> = {}): Request =>
  request('code_find', { name, repo }, extra);

/** The envelope with the per-response fence nonce (random by design) replaced by a fixed word, also inside the fenced text. */
export function withoutNonce(envelope: Envelope): unknown {
  const { untrusted_text: text, ...rest } = envelope;
  if (text === undefined) return rest;
  const entries = text.entries.map((entry) => ({ ...entry, text: entry.text.split(text.nonce).join('NONCE') }));
  return { ...rest, untrusted_text: { nonce: 'NONCE', entries } };
}

export interface CountingClock extends Clock {
  /** Timers armed and neither fired nor cancelled. */
  active(): number;
  /** The delays of the active timers. */
  activeDelays(): number[];
  /** Every delay ever armed, in order. */
  readonly armed: number[];
}

/** A clock that forwards to `inner` and keeps count of its live `after` timers. */
export function countingClock(inner: Clock): CountingClock {
  const live = new Map<number, number>();
  const armed: number[] = [];
  let next = 0;
  return {
    now: () => inner.now(),
    sleep: (ms) => inner.sleep(ms),
    after(ms, fn) {
      const id = next;
      next += 1;
      armed.push(ms);
      live.set(id, ms);
      const cancel = inner.after(ms, () => {
        live.delete(id);
        fn();
      });
      return () => {
        live.delete(id);
        cancel();
      };
    },
    active: () => live.size,
    activeDelays: () => [...live.values()],
    armed,
  };
}

export interface ScriptedIndexer extends Indexer {
  readonly deps: IndexerDeps;
  /** The `worktrees` option of each `start` call, in order. */
  readonly starts: Array<readonly string[] | undefined>;
  readonly builds: string[];
  readonly attaches: string[];
  readonly refreshes: string[];
  stops: number;
  /** Failed paths `status()` reports. */
  failed: FailedPath[];
}

export interface ScriptedIndexers {
  /** Every Indexer the factory made, oldest first. */
  readonly made: ScriptedIndexer[];
  readonly factory: (deps: IndexerDeps) => Indexer;
  /** Settle every pending `start`: resolve it, or reject it with `error`. */
  releaseStart(error?: Error): void;
  /** Where `refresh` and other steps are recorded across Indexers, in order. */
  readonly log: string[];
  /** Hold `refresh` of every Indexer until `release()`; `entered` resolves when one is waiting. */
  gateRefresh(): { readonly entered: Promise<void>; release(): void };
}

export interface ScriptedOptions {
  /** `pending` (default): `start` waits for `releaseStart`. `now`: `start` resolves at once. */
  readonly start?: 'pending' | 'now';
}

/** Indexers that do no work and record what the Tenant asked of them. */
export function scriptedIndexers(options: ScriptedOptions = {}): ScriptedIndexers {
  const made: ScriptedIndexer[] = [];
  const log: string[] = [];
  const waiting: Array<{ resolve(): void; reject(error: Error): void }> = [];
  let refreshGate: { entered: () => void; wait: Promise<void> } | undefined;

  const factory = (deps: IndexerDeps): Indexer => {
    const status = (): IndexerStatus => ({
      queued: 0,
      running: 0,
      failed: indexer.failed,
      lastIndexedAt: null,
      watchProblems: [],
      watchMode: 'native',
      reconciling: false,
      lastReconcile: null,
    });
    const indexer: ScriptedIndexer = {
      deps,
      starts: [],
      builds: [],
      attaches: [],
      refreshes: [],
      stops: 0,
      failed: [],
      build(worktree) {
        indexer.builds.push(worktree);
        return Promise.resolve({ files: 0, parsed: 0, linked: 0, removed: 0, skipped: [], failed: [] });
      },
      submit() {},
      ensureFresh: () => Promise.resolve({ complete: true, stalePaths: [], invalid: [] }),
      attach(first: unknown, second?: readonly string[]) {
        if (typeof first === 'string') indexer.attaches.push(first);
        else indexer.attaches.push(...(second ?? []));
        return Promise.resolve();
      },
      start(startOptions) {
        indexer.starts.push(startOptions?.worktrees);
        log.push('start');
        if (options.start === 'now') return Promise.resolve();
        return new Promise<void>((resolve, reject) => {
          waiting.push({ resolve, reject });
        });
      },
      reconcile: () => Promise.resolve({ changed: 0, parsed: 0, linked: 0, removed: 0, durationMs: 0 }),
      async refresh(worktree) {
        log.push(`refresh:${worktree}`);
        indexer.refreshes.push(worktree);
        if (refreshGate !== undefined) {
          refreshGate.entered();
          await refreshGate.wait;
        }
        return { processed: 0 };
      },
      status,
      stop() {
        indexer.stops += 1;
        log.push('stop');
        for (const each of waiting.splice(0)) each.resolve();
        return Promise.resolve();
      },
    };
    made.push(indexer);
    return indexer;
  };

  return {
    made,
    factory,
    log,
    releaseStart(error) {
      for (const each of waiting.splice(0)) {
        if (error === undefined) each.resolve();
        else each.reject(error);
      }
    },
    gateRefresh() {
      let release = (): void => {};
      let entered = (): void => {};
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      const enteredPromise = new Promise<void>((resolve) => {
        entered = resolve;
      });
      refreshGate = { entered, wait };
      return { entered: enteredPromise, release };
    },
  };
}

export interface RecordingMetrics {
  readonly metrics: Metrics;
  /** Every event handed to `record`, in order. */
  readonly events: MetricsEvent[];
  /** The Metrics methods called, in order (`record` is not listed; see `events`). */
  readonly calls: string[];
}

/** A Metrics that keeps what it is given. `throwOn` names a method that throws instead. */
export function recordingMetrics(throwOn?: 'record' | 'flush' | 'rollup'): RecordingMetrics {
  const events: MetricsEvent[] = [];
  const calls: string[] = [];
  const base = createNoopMetrics('recording');
  const metrics: Metrics = {
    ...base,
    record(event) {
      if (throwOn === 'record') throw new Error('record failed');
      events.push(event);
    },
    flush() {
      calls.push('flush');
      if (throwOn === 'flush') return Promise.reject(new Error('flush failed'));
      return Promise.resolve();
    },
    report(range) {
      calls.push('report');
      return base.report(range);
    },
    rollup() {
      calls.push('rollup');
      if (throwOn === 'rollup') return Promise.reject(new Error('rollup failed'));
      return Promise.resolve();
    },
  };
  return { metrics, events, calls };
}

export interface TenantWorld {
  readonly repo: TempGitRepo;
  readonly tmp: TempDir;
  readonly manual: ManualEventSource;
  /** Open one more tenant over the same repository (another process, for lease tests). Closed when the test ends. */
  open(overrides?: Partial<TenantDeps>): Promise<Tenant>;
  /** The store directory of the repository (`<repo>/.git/gsd-atlas`). */
  readonly storeDir: string;
}

export async function makeTenantWorld(
  t: TestContext,
  files: Readonly<Record<string, string>> = THREE_FILES,
): Promise<TenantWorld> {
  const repo = await createTempGitRepo({ runner: setupRunner, world: { committed: files } });
  const tmp = makeTempDir();
  const engine = createGrammarEngine();
  const manual = createManualEventSource();
  const tenants: Tenant[] = [];
  const open = async (overrides: Partial<TenantDeps> = {}): Promise<Tenant> => {
    const tree = createSourceTree({ runner: createRealRunner(), repoDir: repo.dir, envOverlay: repo.envOverlay });
    const governor: Governor = overrides.governor ?? createGovernor({ clock: systemClock });
    const tenant = await createTenant({
      tree,
      identity: await tree.identity(),
      repoDir: repo.dir,
      roots: { repoRoot: repo.dir, userDir: path.join(tmp.path, 'user'), builtinDir: toyModules, npmRoots: [] },
      engine,
      governor,
      clock: systemClock,
      cacheRoot: path.join(tmp.path, 'cache'),
      eventSource: () => manual.source,
      ...overrides,
    });
    tenants.push(tenant);
    return tenant;
  };
  t.after(async () => {
    for (const each of tenants) await each.close();
    await engine.dispose();
    tmp.cleanup();
    repo.cleanup();
  });
  return { repo, tmp, manual, open, storeDir: path.join(repo.dir, '.git', 'gsd-atlas') };
}

/** Build the repository's only worktree through `tenant`, failing the test when the build fails. */
export async function buildOk(tenant: Tenant, repo: TempGitRepo): Promise<Envelope> {
  const reply = await tenant.build(repo.dir);
  if (!reply.ok) throw new Error(`build failed: ${JSON.stringify(reply.diagnostics)}`);
  return reply;
}

/** Make `metrics.db` unopenable by putting a directory where the file belongs. */
export function blockMetricsDb(storeDir: string): void {
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(path.join(storeDir, `metrics.db${suffix}`), { force: true });
  fs.mkdirSync(path.join(storeDir, 'metrics.db'));
}

/** What a captured `openStore` call was given, so a test can call `onLeaseChange` the way the store would. */
export interface StoreCapture {
  readonly open: typeof openFactStore;
  /** The `onLeaseChange` handler the Tenant passed. */
  handler(): ((held: boolean) => void) | undefined;
  /** The `takeover` option the Tenant passed. */
  takeover(): { readonly retryMinMs: number; readonly retryMaxMs: number } | undefined;
  /** The store the real opener made. */
  store(): FactStore | undefined;
}

/** An `openStore` that opens the real store and remembers how it was asked to. `wrap` may replace the store. */
export function captureStore(wrap?: (store: FactStore) => FactStore): StoreCapture {
  let handler: ((held: boolean) => void) | undefined;
  let takeover: { readonly retryMinMs: number; readonly retryMaxMs: number } | undefined;
  let made: FactStore | undefined;
  return {
    open: async (dir, deps, options) => {
      handler = options?.onLeaseChange;
      takeover = options?.takeover;
      const real = await openFactStore(dir, deps, options);
      made = wrap === undefined ? real : wrap(real);
      return made;
    },
    handler: () => handler,
    takeover: () => takeover,
    store: () => made,
  };
}
