/**
 * Per-key idle timers with in-flight counts (WR-10, plan 02-41). The Host keeps one registry for its tenants and one
 * for its history module hosts: a key that has had no use, and has no work in flight, for `idleMs` is reported to
 * `onIdle` once and forgotten, so the Host can close what it holds for that key.
 *
 * "In flight" is what makes eviction safe: a caller `begin`s before it looks the resource up and `end`s when the work
 * is done, so a timer that fires meanwhile re-arms instead of reporting, and a resource is never closed under a request.
 * All waiting goes through `Clock.after`, so a test with the fake clock needs no real time.
 */
import type { Clock } from '../facts/index.ts';

export interface IdleRegistryOptions {
  readonly clock: Clock;
  /** How long a key must have been unused, with nothing in flight, before `onIdle` is called. */
  readonly idleMs: number;
  /** Called once when a key goes idle. A throw or a rejection is dropped: the registry has nothing to do with it. */
  readonly onIdle: (key: string) => void | Promise<void>;
}

export interface IdleRegistry {
  /** Record a use of `key` and (re)start its idle period. */
  touch(key: string): void;
  /** One more piece of work in flight for `key`: the key is not reported idle until every `begin` has an `end`. */
  begin(key: string): void;
  /** A piece of work for `key` is done. This is a use: the idle period restarts. */
  end(key: string): void;
  /**
   * The resource of `key` is no good (its store closed itself): report it now, or, when work is in flight, the moment
   * the last piece ends, without waiting for the idle period. Never closes a resource under a request.
   */
  evict(key: string): void;
  /** Cancel the timer of `key` and drop its count (the resource was closed some other way). */
  forget(key: string): void;
  /** Cancel every timer. Nothing arms afterwards. Safe to call twice. */
  close(): void;
}

interface Entry {
  inFlight: number;
  lastUse: number;
  cancel: (() => void) | undefined;
  /** Reported as soon as nothing is in flight, whatever the idle period says (see `evict`). */
  evict: boolean;
}

export function createIdleRegistry(options: IdleRegistryOptions): IdleRegistry {
  const { clock, idleMs, onIdle } = options;
  if (!Number.isFinite(idleMs) || idleMs <= 0) {
    throw new RangeError('idleMs must be a finite number of milliseconds, above zero');
  }
  const entries = new Map<string, Entry>();
  let closed = false;

  function arm(key: string, entry: Entry, delay: number): void {
    entry.cancel?.();
    entry.cancel = clock.after(delay, () => {
      fire(key);
    });
  }

  function fire(key: string): void {
    const entry = entries.get(key);
    if (entry === undefined || closed) return;
    entry.cancel = undefined;
    if (entry.inFlight > 0) {
      arm(key, entry, idleMs);
      return;
    }
    const quiet = clock.now() - entry.lastUse;
    if (quiet < idleMs) {
      arm(key, entry, idleMs - quiet);
      return;
    }
    report(key);
  }

  /** Forget `key` and tell the caller it is done with. */
  function report(key: string): void {
    const entry = entries.get(key);
    entry?.cancel?.();
    entries.delete(key);
    try {
      Promise.resolve(onIdle(key)).catch(() => {});
    } catch {
      // a throwing handler is the caller's problem, not the registry's
    }
  }

  function entryFor(key: string): Entry {
    let entry = entries.get(key);
    if (entry === undefined) {
      entry = { inFlight: 0, lastUse: clock.now(), cancel: undefined, evict: false };
      entries.set(key, entry);
    }
    return entry;
  }

  function touch(key: string): void {
    if (closed) return;
    const entry = entryFor(key);
    entry.lastUse = clock.now();
    arm(key, entry, idleMs);
  }

  return {
    touch,
    begin(key) {
      if (closed) return;
      const entry = entryFor(key);
      entry.inFlight += 1;
      entry.lastUse = clock.now();
      if (entry.cancel === undefined) arm(key, entry, idleMs);
    },
    end(key) {
      if (closed) return;
      const entry = entryFor(key);
      entry.inFlight = Math.max(0, entry.inFlight - 1);
      if (entry.evict && entry.inFlight === 0) {
        report(key);
        return;
      }
      touch(key);
    },
    evict(key) {
      if (closed) return;
      const entry = entryFor(key);
      entry.evict = true;
      if (entry.inFlight === 0) report(key);
    },
    forget(key) {
      entries.get(key)?.cancel?.();
      entries.delete(key);
    },
    close() {
      closed = true;
      for (const entry of entries.values()) entry.cancel?.();
      entries.clear();
    },
  };
}
