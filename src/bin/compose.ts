import type { Envelope } from '../facts/index.ts';
import { diagnostic, failEnvelope } from '../facts/index.ts';
import type { HostClient } from '../host-client/index.ts';
import type { Host } from '../host/index.ts';

export interface ComposeOptions {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stderr: { write(text: string): unknown };
  readonly home?: string;
}

export interface Composed {
  readonly host: Host;
  readonly client: HostClient;
  dispose(): Promise<void>;
}

/** RED-phase stand-in: a client that refuses every request. */
export function composeHost(_options: ComposeOptions): Composed {
  const refuse = (): Promise<Envelope> =>
    Promise.resolve(failEnvelope('gsd-atlas.error/1', [diagnostic('unknown_kind', 'error', 'the composition root is not built yet')]));
  const host: Host = { handle: refuse, closeTenant: () => Promise.resolve(), close: () => Promise.resolve() };
  return { host, client: { handle: refuse }, dispose: () => Promise.resolve() };
}
