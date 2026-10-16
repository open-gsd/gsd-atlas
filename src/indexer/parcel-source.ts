/**
 * The production EventSource on @parcel/watcher. RED stub: the implementation follows.
 */
import type { EventSource } from './event-source.ts';

export interface WatcherEvent {
  readonly path: string;
  readonly type: string;
}

export interface WatcherSubscription {
  unsubscribe(): Promise<void>;
}

export interface WatcherOptions {
  readonly ignore?: string[];
}

export interface WatcherApi {
  subscribe(
    dir: string,
    fn: (error: Error | null, events: readonly WatcherEvent[]) => unknown,
    options?: WatcherOptions,
  ): Promise<WatcherSubscription>;
  writeSnapshot(dir: string, snapshot: string, options?: WatcherOptions): Promise<string>;
  getEventsSince(dir: string, snapshot: string, options?: WatcherOptions): Promise<readonly WatcherEvent[]>;
}

export interface ParcelEventSourceOptions {
  readonly watcher?: () => Promise<WatcherApi>;
  readonly snapshotDir?: string;
}

export function createParcelEventSource(_options: ParcelEventSourceOptions = {}): EventSource {
  throw new Error('the parcel event source is not implemented yet');
}
