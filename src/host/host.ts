/**
 * The Host: the composition root for a process (tenant-composition ADR decision 5). It validates a request,
 * resolves its repository to a worktree, finds or lazily creates that repository's Tenant, runs the work through
 * the shared Governor in the request's class, and returns the Envelope. The tenant registry is function-scoped
 * state: there are no module-level singletons, so two Hosts in one process are fully independent.
 *
 * A tenant is created on the first code request for its repository, never before, so `lang_list` and a tool listing
 * pay no store-open or Reconcile cost. Tenants never see each other's requests: the registry key is the store id
 * Source Tree derives from the repository's root commit and its real common git directory.
 */
import path from 'node:path';
import { createRealRunner, decide } from '../command-runner/index.ts';
import type { CommandRunner } from '../command-runner/index.ts';
import { SchemaTooNew, findExistingStore, probeStore } from '../fact-store/index.ts';
import type { ResolveStoreLocationInput } from '../fact-store/index.ts';
import { PROTOCOL_VERSION, createAnswerId, diagnostic, failEnvelope, okEnvelope, systemClock } from '../facts/index.ts';
import type { Envelope, Request } from '../facts/index.ts';
import { createGovernor } from '../governor/index.ts';
import type { Governor, JobClass } from '../governor/index.ts';
import { createModuleHost } from '../indexer/index.ts';
import type { IndexerConfig, ModuleHost } from '../indexer/index.ts';
import { ERROR_SCHEMA, TOOL_NAMES, errorEnvelope } from '../query/index.ts';
import { createSourceTree } from '../source-tree/index.ts';
import type { SourceTree } from '../source-tree/index.ts';
import { createTenant, notIndexedNoStore } from '../tenant/index.ts';
import type { Tenant } from '../tenant/index.ts';
import { ALLOW_KIND, handleAllow, permissionsFor } from './allow.ts';
import type { AllowDeps } from './allow.ts';
import { HOST_DEFAULTS } from './defaults.ts';
import { HISTORY_KIND, runHistory } from './history.ts';
import type { HistoryDeps } from './history.ts';
import { createIdleRegistry } from './idle-registry.ts';
import { LANG_KINDS, handleLang } from './lang.ts';
import { classFor, isAdmissionOnly, isRepoKind, parseRepoArgs, resolveRepository, short } from './route.ts';
import type { RepoArgs, RepoKind, Resolved } from './route.ts';
import type { Host, HostOptions } from './types.ts';

const ignore = (): void => {};

const errorName = (error: unknown): string => {
  const code = (error as { readonly code?: unknown } | null)?.code;
  if (typeof code === 'string' && code !== '') return code;
  return error instanceof Error ? error.name : 'Error';
};

const NOT_A_REPO = 'repo must be an existing directory inside a git repository.';

const ALLOW_FORBIDDEN = 'Approvals are recorded only by a person at a terminal with "gsd-atlas allow"; this server cannot record one.';

/** Envelope schema of an `index_state` reply (internal, plan 02-44). */
export const INDEX_STATE_SCHEMA = 'gsd-atlas.index-state/1';

/** The data of an `index_state` reply: the repository's main worktree, and whether it has an index to read. */
export interface IndexStateData {
  readonly repo: string;
  readonly indexed: boolean;
}

export function createHost(options: HostOptions): Host {
  const tenants = new Map<string, Promise<Tenant>>();
  const clock = options.clock ?? systemClock;
  const config = options.config ?? {};
  const hostCwd = options.cwd ?? options.roots.repoRoot;
  const cacheRoot = options.cacheRoot ?? path.join(options.userDir ?? options.roots.userDir, 'cache');
  let closed = false;

  // WR-10: a tenant, and a history module host, idle for the approved `host.idleEvictMs` is closed and forgotten.
  // `closing` holds a tenant that is being closed, so a request for the same store waits for its lease to go.
  const idleEvictMs = options.idleEvictMs ?? HOST_DEFAULTS.idleEvictMs;
  const closing = new Map<string, Promise<void>>();
  const tenantIdle = createIdleRegistry({ clock, idleMs: idleEvictMs, onIdle: (storeId) => closeTenant(storeId) });
  const historyIdle = createIdleRegistry({ clock, idleMs: idleEvictMs, onIdle: (repoDir) => disposeHistoryModule(repoDir) });

  // The real runner and Governor are created on first use, so a Host that only serves lang kinds builds neither.
  let runner: CommandRunner | undefined = options.runner;
  let governor: Governor | undefined = options.governor;
  // D-15, SEC-02: who started this Host decides which permission list it may use. An agent's server (`mcp`) has none
  // unless the person started it with `--allow-build`; a Host given its own runner was composed with the same rule.
  const origin = options.origin ?? 'cli';
  const permissions = permissionsFor(origin, options.allowBuild === true, config.permissions);
  const getRunner = (): CommandRunner => (runner ??= createRealRunner(permissions === undefined ? {} : { user: permissions }));
  const getGovernor = (): Governor => (governor ??= createGovernor({ clock }));

  const makeTree = (repoDir: string): SourceTree =>
    createSourceTree({ runner: getRunner(), repoDir, ...(options.gitEnv === undefined ? {} : { envOverlay: options.gitEnv }) });

  /** The user's Indexer settings; a key they left out keeps its approved default. */
  function indexerSettings(): Partial<IndexerConfig> | undefined {
    const given = config.indexer;
    if (given === undefined) return undefined;
    return {
      ...(given.debounceMs === undefined ? {} : { debounceMs: given.debounceMs }),
      ...(given.maxWaitMs === undefined ? {} : { maxWaitMs: given.maxWaitMs }),
    };
  }

  /**
   * What decides where a repository's store lives. The ONE place it is built, so the tenant's store location and the
   * Host's look at whether a store exists can never drift apart (WR-01): both read the user's `store.dir` and the
   * Host's cache root, never anything from the repository (T-02-36).
   */
  const storeSettings = (): { readonly cacheRoot: string; readonly storeDir?: string } => ({
    cacheRoot,
    ...(config.store?.dir === undefined ? {} : { storeDir: config.store.dir }),
  });

  /** The location rules' input for `resolved`, exactly as `createTenant` builds it from the same settings. */
  function locationInput(resolved: Resolved): ResolveStoreLocationInput {
    const settings = storeSettings();
    return {
      storeId: resolved.identity.storeId,
      commonDir: resolved.identity.commonDir,
      repoDir: resolved.repoDir,
      cacheRoot: settings.cacheRoot,
      ...(settings.storeDir === undefined ? {} : { override: settings.storeDir }),
    };
  }

  function tenantFor(resolved: Resolved): Promise<Tenant> {
    const key = resolved.identity.storeId;
    const known = tenants.get(key);
    if (known !== undefined) return known;
    const indexer = indexerSettings();
    const created = (options.tenantFactory ?? createTenant)({
      tree: resolved.tree,
      identity: resolved.identity,
      repoDir: resolved.repoDir,
      roots: options.roots,
      engine: options.engine,
      governor: getGovernor(),
      clock,
      ...storeSettings(),
      ...(indexer === undefined ? {} : { indexer }),
      ...(config.gc?.graceMs === undefined ? {} : { graceMs: config.gc.graceMs }),
      // SEC-02: the user's list of first-party providers to turn off (plan 03-23 reads it; nothing does yet).
      ...(config.providers === undefined ? {} : { providers: config.providers }),
      ...(options.version === undefined ? {} : { version: options.version }),
      ...(options.metrics === undefined ? {} : { metrics: options.metrics }),
      ...(options.eventSource === undefined ? {} : { eventSource: options.eventSource }),
      ...(options.indexerFactory === undefined ? {} : { indexerFactory: options.indexerFactory }),
      ...(options.tuning === undefined ? {} : { tuning: options.tuning }),
    });
    tenants.set(key, created);
    // A failed creation is forgotten, so the next request tries again; the callers see the failure themselves.
    created.catch(() => {
      if (tenants.get(key) === created) tenants.delete(key);
    });
    return created;
  }

  /** An envelope for a repository whose tenant could not be created: this repository only (T-02-68). */
  function tenantFailure(error: unknown): Envelope {
    if (error instanceof SchemaTooNew) {
      return errorEnvelope('schema_too_new', 'The index of this repository was written by a newer gsd-atlas. Upgrade gsd-atlas, or remove the index.');
    }
    return errorEnvelope('store_unavailable', short(`The index of this repository could not be opened (${errorName(error)}).`));
  }

  const busy = (retryAfter: number): Envelope =>
    errorEnvelope('busy', `The host is busy. Try again in ${String(retryAfter)} milliseconds.`, { retry_after: retryAfter });

  /** Run `work` in a Governor slot of `cls`; a busy answer ends the request without running it (HST-03). */
  async function held(tenant: string, cls: JobClass, work: () => Promise<Envelope>): Promise<Envelope> {
    const outcome = await getGovernor().run({ tenant, class: cls, cost: 1 }, work);
    if (outcome.kind === 'ok') return outcome.value;
    if (outcome.kind === 'busy') return busy(outcome.retry_after);
    return errorEnvelope('timeout', 'The request took too long and was stopped.');
  }

  /**
   * Wait for a turn in the Governor class without holding the slot while the work runs. A build or a maintenance
   * task is scheduled in pieces by the Indexer in this same class; holding a slot for the whole request as well
   * would let a few builds starve their own pieces of slots.
   */
  async function admitted(tenant: string, cls: JobClass, work: () => Promise<Envelope>): Promise<Envelope> {
    const outcome = await getGovernor().run({ tenant, class: cls, cost: 1 }, () => Promise.resolve());
    if (outcome.kind === 'busy') return busy(outcome.retry_after);
    if (outcome.kind === 'timeout') return errorEnvelope('timeout', 'The request took too long and was stopped.');
    return work();
  }

  /** The request Query sees: `atlas_status` takes only `repo`, which the worktree already carries. */
  function forwarded(request: Request, kind: RepoKind): Request {
    if (kind !== 'atlas_status') return request;
    const { repo: _repo, cwd: _cwd, ...rest } = (request.args ?? {}) as Record<string, unknown>;
    return { ...request, args: rest };
  }

  /**
   * The ONE predicate that says whether a repository has an index to read: a tenant is already open for it, or the
   * shared location rules find a store file that holds an index (or one written by a newer gsd-atlas, which a tenant
   * reports as `schema_too_new`). It opens no tenant, takes no lease and writes nothing; the read gate of every
   * non-build request and the `index_state` request both ask it, so they can never disagree. A probe that fails
   * throws, and each caller turns that into its own error envelope.
   */
  async function hasIndex(resolved: Resolved): Promise<boolean> {
    if (tenants.has(resolved.identity.storeId)) return true;
    const existing = findExistingStore(locationInput(resolved));
    if (existing === undefined) return false;
    const state = await probeStore(existing);
    return state === 'indexed' || state === 'newer_schema';
  }

  async function repoRequest(request: Request, kind: RepoKind): Promise<Envelope> {
    const parsed: RepoArgs = parseRepoArgs(kind, request.args);
    if (!parsed.ok) return errorEnvelope('invalid_args', parsed.message);

    const resolved = await resolveRepository(parsed.selection, hostCwd, makeTree);
    if (resolved === null) return errorEnvelope('not_a_repo', NOT_A_REPO);

    // WR-10: the request is counted as in flight BEFORE its tenant is looked up, so the idle timer can never close a
    // tenant under it. When it ends, a repository that has no tenant (nothing was built) keeps no idle timer.
    const key = resolved.identity.storeId;
    tenantIdle.begin(key);
    try {
      return await serveRepo(request, kind, parsed, resolved);
    } finally {
      tenantIdle.end(key);
      if (!tenants.has(key)) tenantIdle.forget(key);
    }
  }

  async function serveRepo(
    request: Request,
    kind: RepoKind,
    parsed: Extract<RepoArgs, { readonly ok: true }>,
    resolved: Resolved,
  ): Promise<Envelope> {
    // A tenant that is being closed (idle eviction, `closeTenant`) releases its writer lease before a new one may
    // open the same store; otherwise the new tenant would find the lease taken and start as a follower.
    await closing.get(resolved.identity.storeId);

    // Plan 02-44: `index_state` is the read gate's own question, answered and nothing more: no tenant, no lease, no write.
    if (kind === 'index_state') {
      try {
        const data: IndexStateData = { repo: resolved.repoDir, indexed: await hasIndex(resolved) };
        return okEnvelope(INDEX_STATE_SCHEMA, data);
      } catch (error) {
        return tenantFailure(error);
      }
    }

    // WR-01: only `build` may create a store. Any other kind needs a tenant that is already open or a store that
    // already holds an index; otherwise nothing is opened, created, locked or written (QRY-06).
    // WR-02: a store that exists but holds nothing to read is not opened by a question either, because opening it
    // as the leader would take the lease and make the advertised `gsd-atlas build` fail with exit 3.
    if (kind !== 'build') {
      try {
        if (!(await hasIndex(resolved))) return notIndexedNoStore();
      } catch (error) {
        return tenantFailure(error);
      }
    }

    let tenant: Tenant;
    try {
      tenant = await tenantFor(resolved);
    } catch (error) {
      return tenantFailure(error);
    }

    const cls = classFor(kind);
    const run = (): Promise<Envelope> => {
      switch (kind) {
        case 'build':
          return tenant.build(resolved.worktree);
        case 'maintain':
          return tenant.maintain(parsed.task, { worktree: resolved.worktree, full: parsed.full });
        case 'status':
          return tenant.statusEnvelope(parsed.sinceMs);
        default:
          return tenant.handle(forwarded(request, kind), resolved.worktree);
      }
    };
    const reply = await (isAdmissionOnly(kind) ? admitted(tenant.storeId, cls, run) : held(tenant.storeId, cls, run));
    // A tenant whose store closed itself (after a failed recovery) can only answer `store_unavailable` from now on.
    // It is closed and forgotten so the next request retries with a fresh one; the registry holds the close back
    // until every request still running on this tenant, this one included, has ended.
    if (reply.diagnostics.some((entry) => entry.code === 'store_unavailable')) tenantIdle.evict(resolved.identity.storeId);
    return reply;
  }

  /**
   * The module host of a repository's history questions, created on first use and shared by later ones, until it has
   * been idle for `idleEvictMs` (WR-10), when it is disposed and the next question makes a new one.
   */
  const historyModules = new Map<string, ModuleHost>();
  function historyModuleHost(repoDir: string): ModuleHost {
    let found = historyModules.get(repoDir);
    if (found === undefined) {
      found =
        options.moduleHostFactory?.(repoDir) ??
        createModuleHost({ engine: options.engine, roots: { ...options.roots, repoRoot: repoDir } });
      historyModules.set(repoDir, found);
    }
    return found;
  }

  async function disposeHistoryModule(repoDir: string): Promise<void> {
    const found = historyModules.get(repoDir);
    if (found === undefined) return;
    historyModules.delete(repoDir);
    await found.dispose().catch(ignore);
  }

  /**
   * `history` (STO-09): needs a Source Tree, a module host and the engine, never a Tenant, so it works on a repository
   * nobody indexed and in a process that is not the writer. It reads git objects and writes only to a throwaway store.
   */
  async function historyRequest(request: Request): Promise<Envelope> {
    const parsed: RepoArgs = parseRepoArgs('code_find', request.args);
    if (!parsed.ok) return errorEnvelope('invalid_args', parsed.message);
    const resolved = await resolveRepository(parsed.selection, hostCwd, makeTree);
    if (resolved === null) return errorEnvelope('not_a_repo', NOT_A_REPO);
    // WR-10: counted as in flight before the module host is looked up, so it is never disposed under this question.
    historyIdle.begin(resolved.repoDir);
    try {
      return await serveHistory(request, resolved);
    } finally {
      historyIdle.end(resolved.repoDir);
    }
  }

  function serveHistory(request: Request, resolved: Resolved): Promise<Envelope> {
    const deps: HistoryDeps = {
      tree: resolved.tree,
      modules: historyModuleHost(resolved.repoDir),
      clock,
      worktree: resolved.worktree,
      repoName: resolved.identity.storeId,
      keepOut: [resolved.repoDir, resolved.identity.commonDir, ...(config.store?.dir === undefined ? [] : [config.store.dir])],
      ...(options.history?.tmpRoot === undefined ? {} : { tmpRoot: options.history.tmpRoot }),
      ...(options.history?.maxFiles === undefined ? {} : { maxFiles: options.history.maxFiles }),
      ...(options.history?.nonce === undefined ? {} : { nonce: options.history.nonce }),
    };
    return held(resolved.identity.storeId, classFor('code_find'), () => runHistory(deps, request));
  }

  /**
   * `allow` (D-15): the CLI's two-step approval of one command. It needs the repository's identity (git, through the same
   * resolver every repo request uses) and the user's directory, never a tenant or a store, so it works on a repository
   * nobody indexed. It runs in the `interactive` class under one fixed Governor key: approvals are rare and have no
   * tenant to be fair to.
   */
  function allowRequest(request: Request): Promise<Envelope> {
    const deps: AllowDeps = {
      userDir: options.userDir ?? options.roots.userDir,
      roots: options.roots,
      resolveRepo: async (selection) => {
        const resolved = await resolveRepository(selection, hostCwd, makeTree);
        return resolved === null ? null : { repoDir: resolved.repoDir };
      },
    };
    return held(ALLOW_KIND, classFor('allow'), () => handleAllow(request, deps));
  }

  /**
   * What `lang_list` needs to show a module's `precise.command` as approved: a check, against the permission list THIS Host
   * may use (so an MCP server without `--allow-build` shows it as still needing approval), whether the person approved
   * that exact command for the repository around the request. It asks the very rule the runner will apply, `decide`, and
   * counts only a user approval (the first-party git rule is not an approval). With no list there is nothing to resolve
   * or check, so a Host that has no approvals pays nothing for it. Nothing is started and nothing is read from the repository.
   */
  async function approvalCheck(request: Request): Promise<((command: readonly string[]) => boolean) | undefined> {
    if (request.kind !== 'lang_list' || permissions === undefined || permissions.allow.length === 0) return undefined;
    const args = (typeof request.args === 'object' && request.args !== null ? request.args : {}) as { repo?: unknown; roots?: { repoRoot?: unknown } | null };
    const named =
      typeof args.repo === 'string' ? args.repo : typeof args.roots?.repoRoot === 'string' ? args.roots.repoRoot : options.roots.repoRoot;
    if (!path.isAbsolute(named)) return undefined;
    const resolved = await resolveRepository({ repo: named }, hostCwd, makeTree);
    if (resolved === null) return undefined;
    const { repoDir } = resolved;
    return (command) => {
      const [executable, ...rest] = command;
      if (executable === undefined) return false;
      const decision = decide({ executable, args: rest, cwd: repoDir }, { repo: repoDir }, permissions);
      return decision.allowed && decision.via === 'user';
    };
  }

  async function dispatch(request: Request): Promise<Envelope> {
    if (request.protocol !== PROTOCOL_VERSION) {
      return errorEnvelope(
        'unsupported_protocol',
        `protocol ${short(String(request.protocol))} is not supported; this host speaks protocol ${String(PROTOCOL_VERSION)}`,
      );
    }
    if (closed) return errorEnvelope('host_closed', 'This host was closed.');
    return stampAnswer(request.kind, await route(request));
  }

  /**
   * D-16: a tool answer carries an `answer_id`, added once the answer exists, so the CLI's and the MCP server's JSON both
   * name it and a later `rate --last` or `bug` can point at it without keeping its content. A Tenant stamps (and
   * records) the answers it gives itself, with the same id it hands the flight recorder; the Host stamps the rest of
   * the tool answers: `lang_list`, which needs no Tenant, and a tool request refused before a Tenant saw it. The kinds
   * that are not tool answers (`build`, `maintain`, `status`, `index_state`, `history`, `allow`, `lang_test`) get none.
   */
  function stampAnswer(kind: string, envelope: Envelope): Envelope {
    if (envelope.answer_id !== undefined || !(TOOL_NAMES as readonly string[]).includes(kind)) return envelope;
    return { ...envelope, answer_id: createAnswerId() };
  }

  async function route(request: Request): Promise<Envelope> {
    if ((LANG_KINDS as readonly string[]).includes(request.kind)) {
      const approved = await approvalCheck(request);
      return handleLang(request, { roots: options.roots, engine: options.engine, ...(approved === undefined ? {} : { approved }) });
    }
    if (request.kind === HISTORY_KIND) return historyRequest(request);
    // D-15: an agent's server never records an approval, whatever the request carries. Checked before the arguments are read.
    if (request.kind === ALLOW_KIND) return origin === 'mcp' ? errorEnvelope('allow_forbidden', ALLOW_FORBIDDEN) : allowRequest(request);
    if (isRepoKind(request.kind)) return repoRequest(request, request.kind);
    return errorEnvelope('unknown_kind', `request kind ${short(JSON.stringify(request.kind))} is not known to this host`);
  }

  async function closeTenant(storeId: string): Promise<void> {
    tenantIdle.forget(storeId);
    const found = tenants.get(storeId);
    if (found === undefined) return closing.get(storeId);
    tenants.delete(storeId);
    const done = (async (): Promise<void> => {
      try {
        await (await found).close();
      } catch {
        // A tenant that never opened has nothing to close.
      }
    })();
    closing.set(storeId, done);
    try {
      await done;
    } finally {
      if (closing.get(storeId) === done) closing.delete(storeId);
    }
  }

  return {
    async handle(request: Request): Promise<Envelope> {
      try {
        return await dispatch(request);
      } catch (error) {
        // Only a bug gets here. Say so by name, without the message: it can quote paths.
        return failEnvelope(ERROR_SCHEMA, [
          diagnostic('internal_error', 'error', 'The request failed inside the host.', errorName(error)),
        ]);
      }
    },

    closeTenant,

    async close(): Promise<void> {
      closed = true;
      // No idle timer may fire during shutdown (WR-10).
      tenantIdle.close();
      historyIdle.close();
      await Promise.all([...tenants.keys()].map((storeId) => closeTenant(storeId).catch(ignore)));
      const modules = [...historyModules.values()];
      historyModules.clear();
      await Promise.all(modules.map((each) => each.dispose().catch(ignore)));
    },
  };
}
