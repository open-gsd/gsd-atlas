import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** A temp directory plus the handles (databases, watchers, ...) that must close before removal. */
export interface TempDir {
  readonly path: string;
  /** Register a handle to close during cleanup. Returns the handle for inline use. */
  adopt<T extends { close(): unknown }>(handle: T): T;
  /** Close adopted handles in reverse order, then remove the directory. Safe to call twice. */
  cleanup(): void;
}

class TempDirImpl implements TempDir {
  readonly path: string;
  private handles: Array<{ close(): unknown }> = [];

  constructor(dir: string) {
    this.path = dir;
  }

  adopt<T extends { close(): unknown }>(handle: T): T {
    this.handles.push(handle);
    return handle;
  }

  cleanup(): void {
    // Windows keeps files locked while a handle is open (EBUSY), so close first.
    const failures: unknown[] = [];
    const handles = this.handles.reverse();
    this.handles = [];
    for (const handle of handles) {
      try {
        handle.close();
      } catch (error) {
        failures.push(error);
      }
    }
    fs.rmSync(this.path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    if (failures.length === 1) {
      throw failures[0];
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, 'several adopted handles failed to close');
    }
  }
}

/** Create a short `ga-xxxxxx` directory under os.tmpdir() (short to stay under socket path limits). */
export function makeTempDir(): TempDir {
  return new TempDirImpl(fs.mkdtempSync(path.join(os.tmpdir(), 'ga-')));
}

/**
 * Canonical path. Windows runner temp paths can be 8.3 short names (`RUNNER~1`) and macOS
 * `/var` is a link to `/private/var`, so compare paths through this.
 */
export function realPath(p: string): string {
  return fs.realpathSync.native(p);
}
