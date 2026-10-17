/**
 * Signal handling shared by the bins (IN-07, HST-01, STO-06): the first SIGTERM or SIGINT starts a graceful shutdown
 * (dispose the composed Host, so tenants close, the Indexer and watcher stop, the dirty sentinel is cleared, the
 * writer lease is released and the engine's workers end) and then exits; a second signal while that is under way
 * exits at once, for a dispose that hangs.
 *
 * Exit codes are the conventional signal codes, 128 plus the signal number (143 for SIGTERM, 130 for SIGINT). They are
 * outside the CLI's own 0/1/2/3 table (QRY-04), which is unchanged for every outcome the CLI itself decides.
 *
 * The process, the dispose function and the exit function are injected, so the sequence is tested deterministically;
 * the bins only wire it. Node delivers only SIGINT on Windows; registering SIGTERM there is harmless.
 */

/** The signals handled, with their numbers (identical on every platform Node supports). */
const SIGNAL_NUMBERS = { SIGINT: 2, SIGTERM: 15 } as const;

export type ShutdownSignal = keyof typeof SIGNAL_NUMBERS;

/** The part of `process` this module needs: registering and removing a signal listener. */
export interface SignalSource {
  on(signal: ShutdownSignal, listener: () => void): unknown;
  removeListener(signal: ShutdownSignal, listener: () => void): unknown;
}

export interface ShutdownOptions {
  readonly process: SignalSource;
  /** Release everything the process holds. A rejection is swallowed: the process exits either way. */
  readonly dispose: () => Promise<void>;
  /** Ends the process with the given code (`process.exit` in the bins). */
  readonly exit: (code: number) => void;
  /** Default: SIGINT and SIGTERM. */
  readonly signals?: readonly ShutdownSignal[];
}

export interface ShutdownHandle {
  /** Remove the listeners this call registered. */
  uninstall(): void;
}

/** The conventional exit code of a process ended by `signal`. */
export function signalExitCode(signal: ShutdownSignal): number {
  return 128 + SIGNAL_NUMBERS[signal];
}

export function installShutdownHandlers(options: ShutdownOptions): ShutdownHandle {
  const signals = options.signals ?? (['SIGINT', 'SIGTERM'] as const);
  let shuttingDown = false;
  const registered: Array<{ readonly signal: ShutdownSignal; readonly listener: () => void }> = [];

  for (const signal of signals) {
    const code = signalExitCode(signal);
    const listener = (): void => {
      if (shuttingDown) {
        options.exit(code);
        return;
      }
      shuttingDown = true;
      void (async () => {
        try {
          await options.dispose();
        } catch {
          // The process is ending: a failed teardown must not keep it alive.
        }
        options.exit(code);
      })();
    };
    try {
      options.process.on(signal, listener);
    } catch {
      // A platform that cannot listen for this signal: the others still work.
      continue;
    }
    registered.push({ signal, listener });
  }

  return {
    uninstall(): void {
      for (const { signal, listener } of registered.splice(0)) options.process.removeListener(signal, listener);
    },
  };
}
