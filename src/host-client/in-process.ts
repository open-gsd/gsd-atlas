import type { Envelope, Request } from '../facts/index.ts';
import { createHost } from '../host/index.ts';
import type { Host, HostOptions } from '../host/index.ts';
import type { HostClient } from './index.ts';

/**
 * What the in-process client needs: the Host's options (the default module roots and the Grammar Engine are the
 * ones Phase 1 had; the runner, Governor, clock and the rest default to the real ones, created on first use), or
 * a Host the composition root already built and will close itself.
 */
export interface InProcessHostClientOptions extends HostOptions {
  /** Serve through this Host instead of building one from the options. */
  readonly host?: Host;
}

/**
 * The in-process client: it serves requests in the calling process by handing every kind to the Host. The
 * transport changes in Phase 4; the request and envelope shapes do not.
 */
export function createInProcessHostClient(options: InProcessHostClientOptions): HostClient {
  const host = options.host ?? createHost(options);
  return {
    handle(request: Request): Promise<Envelope> {
      return host.handle(request);
    },
  };
}
