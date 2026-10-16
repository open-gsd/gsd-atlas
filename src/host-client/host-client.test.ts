import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { createGrammarEngine } from '../grammar-engine/index.ts';
import { makeTempDir } from '../test-kit/index.ts';
import { PROTOCOL_VERSION, createInProcessHostClient } from './index.ts';
import type { Diagnostic, Envelope, HostClient, Request } from './index.ts';

const TOY = path.resolve(import.meta.dirname, '..', '..', 'test', 'fixtures', 'modules', 'toy');

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

describe('createInProcessHostClient', () => {
  const engine = createGrammarEngine();
  const client = createInProcessHostClient({ engine });
  const temp = makeTempDir();
  after(async () => {
    await engine.dispose();
    temp.cleanup();
  });

  function basicOnlyModule(): string {
    const dest = path.join(temp.path, 'toy');
    fs.cpSync(TOY, dest, { recursive: true });
    for (const name of ['emoji.toy', 'crlf.toy', 'bom.toy']) {
      fs.rmSync(path.join(dest, 'fixtures', name), { force: true });
      fs.rmSync(path.join(dest, 'fixtures', `${name}.golden.json`), { force: true });
    }
    return dest;
  }

  it('serves lang_test with an ok envelope that carries the report', async () => {
    const reply = await client.handle({ protocol: PROTOCOL_VERSION, kind: 'lang_test', args: { target: basicOnlyModule() } });
    assert.equal(reply.schema, 'gsd-atlas.lang-test/1');
    assert.equal(reply.ok, true);
    assert.deepEqual(reply.diagnostics, []);
    assert.deepEqual(reply.data, { ok: true, module: 'toy', fixtures: [{ file: 'basic.toy', ok: true }], diagnostics: [] });
  });

  it('turns a failing module into a fail envelope with the diagnostics', async () => {
    const reply = await client.handle({
      protocol: PROTOCOL_VERSION,
      kind: 'lang_test',
      args: { target: path.join(temp.path, 'nosuch') },
    });
    assert.equal(reply.ok, false);
    assert.equal(reply.data, null);
    assert.deepEqual(
      reply.diagnostics.map((d) => d.code),
      ['module_not_found'],
    );
  });

  it('rejects an unsupported protocol number before looking at the kind', async () => {
    const reply = await client.handle({ protocol: 99, kind: 'lang_test', args: { target: TOY } });
    assert.equal(reply.ok, false);
    assert.deepEqual(
      reply.diagnostics.map((d) => d.code),
      ['unsupported_protocol'],
    );
  });

  it('answers an unknown kind with unknown_kind', async () => {
    const reply = await client.handle({ protocol: PROTOCOL_VERSION, kind: 'lang_list' });
    assert.equal(reply.ok, false);
    assert.deepEqual(
      reply.diagnostics.map((d) => d.code),
      ['unknown_kind'],
    );
  });

  it('answers lang_test without a usable target with invalid_args', async () => {
    for (const args of [undefined, {}, { target: 3 }, { target: '' }, null]) {
      const reply = await client.handle({ protocol: PROTOCOL_VERSION, kind: 'lang_test', args });
      assert.equal(reply.ok, false);
      assert.deepEqual(
        reply.diagnostics.map((d) => d.code),
        ['invalid_args'],
      );
    }
  });
});
