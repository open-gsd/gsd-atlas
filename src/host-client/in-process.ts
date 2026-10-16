import { PROTOCOL_VERSION, diagnostic, failEnvelope, okEnvelope } from '../facts/index.ts';
import type { Envelope, Request } from '../facts/index.ts';
import type { GrammarEngine } from '../grammar-engine/index.ts';
import { runLangTest } from '../lang/index.ts';
import type { LangTestReport } from '../lang/index.ts';
import type { HostClient } from './index.ts';

/** Envelope schema of a `lang_test` reply. */
export const LANG_TEST_SCHEMA = 'gsd-atlas.lang-test/1';
/** Envelope schema of a reply that is only an error (unsupported protocol, unknown kind, bad args). */
export const ERROR_SCHEMA = 'gsd-atlas.error/1';

export interface InProcessHostClientOptions {
  readonly engine: GrammarEngine;
}

function targetOf(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null || !('target' in args)) {
    return undefined;
  }
  const { target } = args;
  return typeof target === 'string' && target !== '' ? target : undefined;
}

function langTestEnvelope(report: LangTestReport): Envelope<LangTestReport> {
  return report.ok
    ? okEnvelope(LANG_TEST_SCHEMA, report, report.diagnostics)
    : failEnvelope<LangTestReport>(LANG_TEST_SCHEMA, report.diagnostics);
}

/**
 * The Phase 1 host: it serves requests in the calling process. The transport changes in Phase 4;
 * the request and envelope shapes do not. Plan 01-17 adds the `lang_list` kind.
 */
export function createInProcessHostClient(options: InProcessHostClientOptions): HostClient {
  return {
    async handle(request: Request): Promise<Envelope> {
      if (request.protocol !== PROTOCOL_VERSION) {
        return failEnvelope(ERROR_SCHEMA, [
          diagnostic(
            'unsupported_protocol',
            'error',
            `protocol ${String(request.protocol)} is not supported; this host speaks protocol ${String(PROTOCOL_VERSION)}`,
          ),
        ]);
      }
      switch (request.kind) {
        case 'lang_test': {
          const target = targetOf(request.args);
          if (target === undefined) {
            return failEnvelope(ERROR_SCHEMA, [
              diagnostic('invalid_args', 'error', 'lang_test needs args.target: a non-empty module folder path'),
            ]);
          }
          return langTestEnvelope(await runLangTest({ target, engine: options.engine }));
        }
        default:
          return failEnvelope(ERROR_SCHEMA, [
            diagnostic('unknown_kind', 'error', `request kind ${JSON.stringify(request.kind)} is not known to this host`),
          ]);
      }
    },
  };
}
