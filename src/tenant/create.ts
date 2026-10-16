import { diagnostic, failEnvelope } from '../facts/index.ts';
import type { Envelope } from '../facts/index.ts';
import type { Tenant, TenantDeps } from './types.ts';

/** RED-phase stand-in: every request is refused until the Tenant is composed. */
export async function createTenant(deps: TenantDeps): Promise<Tenant> {
  const refuse = (): Promise<Envelope> =>
    Promise.resolve(failEnvelope('gsd-atlas.error/1', [diagnostic('unknown_kind', 'error', 'the tenant is not composed yet')]));
  return {
    storeId: deps.identity.storeId,
    location: { dir: '', kind: 'cache' },
    handle: refuse,
    build: refuse,
    maintain: refuse,
    status: () => Promise.reject(new Error('the tenant is not composed yet')),
    statusEnvelope: refuse,
    close: () => Promise.resolve(),
  };
}
