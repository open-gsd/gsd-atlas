/**
 * Test-only: counts SEQUENTIAL stages of process starts without reading a clock (plan 02-46).
 *
 * A gate wraps any `run(spec)` function. It starts the wrapped run at once but withholds its result until the test
 * releases it. Work that depends on a result (the next process a flow starts after this one answers) therefore
 * cannot begin before the release, so the specs held together in one stage are exactly the processes a flow starts
 * concurrently, and the number of stages is the length of its dependency chain: the quantity that multiplies the
 * per-spawn cost on a slow operating system.
 *
 * A stage ends when no new run has started for `patience` consecutive passes of the event loop (each pass is one
 * `setImmediate` turn and one real file-system round trip, so the flow's own lstat calls complete in between). The
 * count is a number of event-loop turns, not a duration, and no timer or clock is read.
 *
 * Structurally typed on purpose: test-kit imports nothing but `src/facts`, so it cannot name a CommandRunner.
 */
import fs from 'node:fs';

/** How many event-loop passes without a new run end a stage. */
const DEFAULT_PATIENCE = 25;

export interface RunGate<Spec, Ctx, Result> {
  /** Starts the wrapped run now; its result reaches the caller only after the stage that holds it is released. */
  run(spec: Spec, ctx?: Ctx): Promise<Result>;
  /**
   * Waits for the runs that start without waiting for anything, releases them all and returns their specs in start
   * order. An empty array means nothing started: the flow is finished, or busy with something that is not a run.
   */
  nextStage(): Promise<Spec[]>;
  /** Resolves when a run is held (at once when one already is). Polls nothing: a start wakes it. */
  started(): Promise<void>;
}

export function createRunGate<Spec, Ctx, Result>(
  inner: (spec: Spec, ctx?: Ctx) => Promise<Result>,
  options: { readonly patience?: number } = {},
): RunGate<Spec, Ctx, Result> {
  const patience = options.patience ?? DEFAULT_PATIENCE;
  const held: Array<{ readonly spec: Spec; readonly release: () => void }> = [];
  const waiters: Array<() => void> = [];
  const pass = async (): Promise<void> => {
    await new Promise<void>((resolve) => setImmediate(resolve));
    await fs.promises.stat('.');
  };
  return {
    run(spec, ctx) {
      const started = inner(spec, ctx);
      // A rejection is delivered to the caller on release, never as an unhandled rejection of the withheld copy.
      started.catch(() => {});
      return new Promise<Result>((resolve, reject) => {
        held.push({
          spec,
          release: () => {
            started.then(resolve, reject);
          },
        });
        for (const wake of waiters.splice(0)) wake();
      });
    },
    started() {
      return new Promise<void>((resolve) => {
        if (held.length > 0) resolve();
        else waiters.push(resolve);
      });
    },
    async nextStage() {
      let quiet = 0;
      let seen = held.length;
      while (quiet < patience) {
        await pass();
        if (held.length === seen) {
          quiet += 1;
        } else {
          seen = held.length;
          quiet = 0;
        }
      }
      const stage = held.splice(0);
      for (const each of stage) each.release();
      return stage.map((each) => each.spec);
    },
  };
}

/**
 * Drives `operation` to its end one stage at a time and returns the specs of every stage, in order. Between stages
 * the operation may be busy with work that is not a run (parsing, a commit); the loop then waits for it to either
 * finish or start another run.
 */
export async function collectStages<Spec, Ctx, Result>(gate: RunGate<Spec, Ctx, Result>, operation: Promise<unknown>): Promise<Spec[][]> {
  let done = false;
  const finished = operation.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  const stages: Spec[][] = [];
  for (;;) {
    const specs = await gate.nextStage();
    if (specs.length > 0) {
      stages.push(specs);
    } else if (done) {
      break;
    } else {
      await Promise.race([finished, gate.started()]);
    }
  }
  await finished;
  return stages;
}
