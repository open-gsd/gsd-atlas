import { diagnostic, failEnvelope } from '../facts/index.ts';
import type { Host, HostOptions } from './types.ts';

/** RED-phase stand-in: every request is refused until the Host is composed. */
export function createHost(_options: HostOptions): Host {
  return {
    handle: () =>
      Promise.resolve(failEnvelope('gsd-atlas.error/1', [diagnostic('unknown_kind', 'error', 'the host is not composed yet')])),
    closeTenant: () => Promise.resolve(),
    close: () => Promise.resolve(),
  };
}
