/**
 * Render the language-module manifest JSON Schema from the Zod source (D-05).
 *
 *   node scripts/schema-build.ts [file]            write the schema (LF endings)
 *   node scripts/schema-build.ts --check [file]    exit 1 if the file differs from the generated text
 *
 * `file` defaults to schemas/atlas-lang.schema.json; the argument exists so the drift
 * check can be tested without touching the committed file. The logic lives in
 * schema-lib.ts so tests can call it in-process; this file is only the CLI wrapper.
 */
import { runSchemaBuild } from './schema-lib.ts';

const result = runSchemaBuild(process.argv.slice(2));
if (result.stdout !== '') process.stdout.write(result.stdout);
if (result.stderr !== '') process.stderr.write(result.stderr);
process.exit(result.status);
