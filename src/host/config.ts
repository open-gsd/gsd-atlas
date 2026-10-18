/**
 * User-level configuration (trust-boundaries ADR, T-02-67): the settings that change where a store lives, how the
 * Indexer waits and which commands may run come from `<userDir>/config.json` and the environment, and from nowhere
 * else. The loader's only inputs are the user directory and the environment object, so no repository file can reach
 * it; a hostile repository can neither move its own store nor widen the command permissions.
 *
 * A file that is wrong in any way is ignored whole, with one warning: half a configuration is worse than none,
 * because a setting that silently drops could leave a permission narrower or wider than the user wrote.
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { diagnostic } from '../facts/index.ts';
import type { Diagnostic } from '../facts/index.ts';
import { DEFAULT_INDEXER_CONFIG } from '../indexer/index.ts';
import type { UserConfig } from './types.ts';

/** The file inside the user directory. */
export const CONFIG_FILE = 'config.json';

/** The largest config file that is read, in bytes. A bigger file is ignored without being parsed. */
export const CONFIG_MAX_BYTES = 64 * 1024;

/** The environment variable that carries the user's `store.dir`; it wins over the file. */
const STORE_DIR_ENV = 'GSD_ATLAS_STORE_DIR';

/** What {@link loadUserConfig} found: the settings, and one warning for each thing it refused. */
export interface LoadedUserConfig {
  readonly config: UserConfig;
  readonly diagnostics: readonly Diagnostic[];
}

const absolutePath = z
  .string()
  .min(1)
  .refine((value) => path.isAbsolute(value), 'must be an absolute path');

const wholeMs = z.int().positive();

const indexerSchema = z
  .strictObject({ debounceMs: wholeMs.optional(), maxWaitMs: wholeMs.optional() })
  .superRefine((value, context) => {
    // A key left out keeps its approved default, so the order is checked against that default.
    const debounce = value.debounceMs ?? DEFAULT_INDEXER_CONFIG.debounceMs;
    const maxWait = value.maxWaitMs ?? DEFAULT_INDEXER_CONFIG.maxWaitMs;
    if (maxWait < debounce) {
      context.addIssue({ code: 'custom', message: 'maxWaitMs must not be below debounceMs', path: ['maxWaitMs'] });
    }
  });

const schema = z.strictObject({
  store: z.strictObject({ dir: absolutePath.optional() }).optional(),
  indexer: indexerSchema.optional(),
  gc: z.strictObject({ graceMs: z.int().nonnegative().optional() }).optional(),
  permissions: z
    .strictObject({
      allow: z.array(
        z.strictObject({
          repo: absolutePath,
          executable: z.string().min(1),
          argsPrefix: z.array(z.string()).optional(),
          // D-15: binds the entry to one exact command (see command-runner/hash.ts). A malformed value ignores the whole file.
          sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
        }),
      ),
    })
    .optional(),
});

type Read = { readonly kind: 'ok'; readonly text: string } | { readonly kind: 'missing' } | { readonly kind: 'refused'; readonly why: string };

/** Read the file through a bounded buffer, so a huge file is never loaded whole. */
function readBounded(file: string): Read {
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch (error) {
    if ((error as { readonly code?: unknown }).code === 'ENOENT') return { kind: 'missing' };
    return { kind: 'refused', why: 'it could not be opened' };
  }
  try {
    const buffer = Buffer.alloc(CONFIG_MAX_BYTES + 1);
    const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (read > CONFIG_MAX_BYTES) return { kind: 'refused', why: 'it is larger than 64 KiB' };
    return { kind: 'ok', text: buffer.subarray(0, read).toString('utf8') };
  } catch {
    return { kind: 'refused', why: 'it could not be read' };
  } finally {
    fs.closeSync(fd);
  }
}

const ignored = (why: string): Diagnostic =>
  diagnostic('user_config_ignored', 'warning', `The user configuration file was ignored: ${why}. Defaults are in effect.`);

/** The first problem of a refused file, in one sentence that quotes no file content. */
function problemOf(error: z.ZodError): string {
  const issue = error.issues[0];
  const where = issue === undefined || issue.path.length === 0 ? 'the file' : issue.path.map(String).join('.');
  return `${where}: ${issue?.message ?? 'invalid'}`;
}

/**
 * Load the user's configuration. A missing file gives the defaults and no diagnostic. `GSD_ATLAS_STORE_DIR`, when
 * it is an absolute path, replaces `store.dir`; a relative one is ignored with a warning.
 */
export function loadUserConfig(userDir: string, env: Readonly<Record<string, string | undefined>>): LoadedUserConfig {
  const diagnostics: Diagnostic[] = [];
  let config: UserConfig = {};

  const read = readBounded(path.join(userDir, CONFIG_FILE));
  if (read.kind === 'refused') {
    diagnostics.push(ignored(read.why));
  } else if (read.kind === 'ok') {
    let json: unknown;
    try {
      json = JSON.parse(read.text);
    } catch {
      json = undefined;
      diagnostics.push(ignored('it is not valid JSON'));
    }
    if (json !== undefined) {
      const parsed = schema.safeParse(json);
      if (parsed.success) config = parsed.data;
      else diagnostics.push(ignored(problemOf(parsed.error)));
    }
  }

  const fromEnv = env[STORE_DIR_ENV];
  if (fromEnv !== undefined && fromEnv !== '') {
    if (path.isAbsolute(fromEnv)) config = { ...config, store: { ...config.store, dir: fromEnv } };
    else diagnostics.push(diagnostic('user_config_ignored', 'warning', `${STORE_DIR_ENV} must be an absolute path and was ignored.`));
  }
  return { config, diagnostics };
}
