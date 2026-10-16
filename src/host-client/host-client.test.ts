import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PROTOCOL_VERSION } from './index.ts';
import type { Diagnostic, Envelope, HostClient, Request } from './index.ts';

describe('HostClient', () => {
  it('a hand-written fake resolves handle() to an Envelope', async () => {
    const seen: Request[] = [];
    const warning: Diagnostic = { code: 'w', severity: 'warning', message: 'careful' };
    const fake: HostClient = {
      async handle(request: Request): Promise<Envelope> {
        seen.push(request);
        return { schema: 'echo.v1', ok: true, data: request.kind, diagnostics: [warning] };
      },
    };

    const reply = await fake.handle({ protocol: PROTOCOL_VERSION, kind: 'ping' });
    assert.equal(reply.ok, true);
    assert.equal(reply.data, 'ping');
    assert.deepEqual(reply.diagnostics, [warning]);
    assert.equal(seen[0]!.protocol, 1);
  });

  it('re-exports PROTOCOL_VERSION as the number 1', () => {
    assert.equal(PROTOCOL_VERSION, 1);
  });
});
