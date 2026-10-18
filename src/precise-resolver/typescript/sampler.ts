/**
 * The RSS sampler (plan 03-27, D-21, TSM-05; flagged deviation OQ2: the memory watch lives inside the compiler process).
 *
 * The compiler worker starts one extra thread running this file. Every `sampleMs` the thread reads the RSS of the whole
 * process; past the limit it writes one marker line to stderr and ends the process with SIGKILL. Because it is a thread of
 * its own it still runs while the main thread is blocked inside a long `createProgram` (verified on macOS in the research),
 * and it needs no per-OS process listing in the parent. The parent reads the marker line from the worker's stderr and
 * answers `memory_budget`; a SIGKILL without the marker is a crash (`resolver_failed`).
 *
 * The V8 heap flag (`--max-old-space-size`) stays the backstop: it ends the process on its own if this thread could not.
 * On Windows `process.kill(process.pid, 'SIGKILL')` is believed to terminate the process but is unverified there (research
 * assumption A3); the three-OS CI run of the small-budget test is the check.
 *
 * This file is both the module the worker imports and the thread's entry: the thread body runs only inside a thread whose
 * `workerData` names it, so importing the module (a test, the worker) has no effect.
 */
import fs from 'node:fs';
import { Worker, isMainThread, workerData } from 'node:worker_threads';
import { resolveSamplerUrl } from './sampler-url.ts';

/** The word that starts the marker line. The parent matches the whole line, so no other output is taken for it. */
export const MEMORY_MARKER = 'GSD_ATLAS_MEMORY_LIMIT';

/** The line the sampler writes before it ends the process. */
export function markerLine(rssBytes: number, limitBytes: number): string {
  return `${MEMORY_MARKER} rss=${String(Math.round(rssBytes))} limit=${String(Math.round(limitBytes))}\n`;
}

/** The pattern of one marker line, anchored to the line (stderr may hold other lines). */
export const MARKER_PATTERN = /^GSD_ATLAS_MEMORY_LIMIT rss=[0-9]+ limit=[0-9]+$/m;

/** True when `rssBytes` is strictly above `limitBytes`. A limit that is not a positive finite number is a programming error. */
export function shouldKill(rssBytes: number, limitBytes: number): boolean {
  if (!Number.isFinite(limitBytes) || limitBytes <= 0) throw new RangeError('shouldKill: the limit must be a positive finite number of bytes');
  if (Number.isNaN(rssBytes)) throw new RangeError('shouldKill: the RSS must be a number');
  return rssBytes > limitBytes;
}

const SAMPLER_KIND = 'gsd-atlas-rss-sampler';

interface SamplerData {
  readonly kind: typeof SAMPLER_KIND;
  readonly rssLimitBytes: number;
  readonly sampleMs: number;
}

export interface SamplerOptions {
  /** The RSS limit in whole megabytes. */
  readonly rssLimitMb: number;
  /** The period in milliseconds. */
  readonly sampleMs: number;
}

/** Start the sampler thread. It is unref'd: it never keeps the process alive, and it ends with the process. */
export function startSampler(options: SamplerOptions): Worker {
  const data: SamplerData = { kind: SAMPLER_KIND, rssLimitBytes: options.rssLimitMb * 1_048_576, sampleMs: options.sampleMs };
  const thread = new Worker(resolveSamplerUrl(), { workerData: data });
  thread.unref();
  return thread;
}

function isSamplerData(value: unknown): value is SamplerData {
  return typeof value === 'object' && value !== null && 'kind' in value && value.kind === SAMPLER_KIND;
}

function runSampler(data: SamplerData): void {
  const tick = (): void => {
    const rss = process.memoryUsage.rss();
    if (!shouldKill(rss, data.rssLimitBytes)) return;
    try {
      // Synchronous and direct: nothing buffered, nothing that waits for the blocked main thread.
      fs.writeSync(2, markerLine(rss, data.rssLimitBytes));
    } catch {
      // stderr is gone; the kill below still ends the process
    }
    process.kill(process.pid, 'SIGKILL');
  };
  tick();
  setInterval(tick, data.sampleMs);
}

if (!isMainThread && isSamplerData(workerData)) runSampler(workerData);
