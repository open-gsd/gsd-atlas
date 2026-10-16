// Module-boundary lint (D-12, FND-07). Plain ESM JavaScript on purpose: ESLint does not load TS configs without jiti.
//
// Flat config REPLACES rule options when a later block matches the same file, so every module gets exactly one
// production block and (later in the array, so it wins) one test-context block, each carrying that module's COMPLETE
// pattern list. Never split one module's patterns across two blocks that match the same files.
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

/** Directories under src/ known to the boundary lint. */
export const MODULES = [
  'facts',
  'sqlite',
  'command-runner',
  'source-tree',
  'fact-store',
  'grammar-engine',
  'precise-resolver',
  'governor',
  'lang',
  'host-client',
  'policy',
  'cli',
  'mcp-shim',
  'test-kit',
  'metrics',
  'sdk',
  'bin',
  // Phase 2: each gets its production and test boundary blocks from its first file. None is a SQLite owner or an adapter.
  'indexer',
  'query',
  'tenant',
  'host',
];

/** The only modules that may touch src/sqlite (and so a SQLite driver). */
export const SQLITE_OWNERS = ['fact-store', 'metrics', 'sdk', 'sqlite'];

/** Adapters import only host-client (plus npm packages and node: built-ins). */
export const ADAPTERS = ['cli', 'mcp-shim'];

/**
 * Closed modules: the only other src modules they may import, and whether node: built-ins are allowed.
 * `allow` lists module names; any other npm package is always banned for a closed module.
 * Leaf properties are lint rules rather than conventions: because test-kit can import only facts, a
 * command-runner to test-kit cycle is impossible by construction.
 */
export const CLOSED_IMPORTS = {
  facts: { allow: [], builtins: true },
  'test-kit': { allow: ['facts'], builtins: true },
  policy: { allow: ['facts'], builtins: false },
};

/** Test context per module: unit tests and contract suites. Production purity does not apply here. */
export const TEST_CONTEXT_FILES = Object.fromEntries(
  MODULES.map((m) => [m, [`src/${m}/**/*.test.ts`, `src/${m}/**/contract.ts`]]),
);

const CP = '(?:node:)?child_process';
const DRIVERS = '(?:node:sqlite|better-sqlite3)';
const TEST_CODE = 'is test code and the compiled package must not load it';

const deepImport = (m) => ({
  regex: `(^|/)${m}/(?!index\\.ts$).+`,
  message: `Import ${m} only through ${m}/index.ts (D-12: cross-module imports go through index.ts, never deep paths).`,
});
const forbid = (m, message) => ({ regex: `(^|/)${m}(/|$)`, message });

// Production purity: non-test files must never reach test code, so the shipped package carries none of it.
const PURITY = [
  { regex: '^node:test(?:/.*)?$', message: `node:test ${TEST_CODE}; only *.test.ts and contract.ts files may import it.` },
  { regex: '(?:^|/)contract(?:\\.ts)?$', message: `Contract suites are test code: a contract.ts file ${TEST_CODE}. Only the same module's *.test.ts and contract.ts may import it.` },
];
const TEST_KIT_PURITY = forbid('test-kit', `src/test-kit is test code: it ${TEST_CODE}. Only *.test.ts and contract.ts files may import it.`);

/**
 * Complete no-restricted-imports pattern list for a module.
 * @param {string} mod module directory name under src/
 * @param {{ testContext?: boolean }} [opts] testContext drops the production-purity patterns (and policy's bare-import ban)
 */
export function patternsFor(mod, opts = {}) {
  const testContext = opts.testContext === true;
  const p = [];
  if (!testContext) p.push(...PURITY, TEST_KIT_PURITY);
  if (mod !== 'command-runner') {
    p.push({ regex: `^${CP}$`, message: 'child_process is allowed only in src/command-runner (FND-06: one CommandRunner spawns every process).' });
  }
  if (mod !== 'sqlite') {
    p.push({ regex: `^${DRIVERS}$`, message: 'SQLite drivers (node:sqlite, better-sqlite3) are allowed only in src/sqlite.' });
  }
  const closed = CLOSED_IMPORTS[mod];
  if (closed) {
    for (const m of MODULES) {
      if (m === mod || closed.allow.includes(m)) continue;
      const why = m === 'test-kit'
        ? `src/test-kit is test code: it ${TEST_CODE}. ${mod} is a leaf and may import only ${closed.allow.join(', ') || 'node: built-ins'}.`
        : `${mod} is closed: it may import only ${closed.allow.length ? closed.allow.map((a) => a + '/').join(', ') : 'relative files'}${closed.builtins ? ' and node: built-ins' : ''}, not ${m}/.`;
      p.push(forbid(m, why));
    }
    if (!(testContext && mod === 'policy')) {
      p.push({
        regex: closed.builtins ? '^(?!\\.|node:)' : '^(?!\\.)',
        message: `${mod} is closed: no npm packages${closed.builtins ? '' : ' and no node: built-ins'} (relative imports${closed.builtins ? ' and node: built-ins' : ''} only).`,
      });
    }
  }
  if (ADAPTERS.includes(mod)) {
    for (const m of MODULES) {
      if (m === mod || m === 'host-client') continue;
      if (testContext && m === 'test-kit') continue; // test code may use the test kit; production adapters may not
      p.push(forbid(m, `Adapters (${ADAPTERS.join(', ')}) import only host-client, not ${m}.`));
    }
  }
  if (!SQLITE_OWNERS.includes(mod)) p.push(forbid('sqlite', 'src/sqlite is private to fact-store, metrics and sdk.'));
  for (const m of MODULES) if (m !== mod) p.push(deepImport(m));
  return p;
}

const PARSE_SELECTOR = {
  selector: "CallExpression[callee.type='MemberExpression'][callee.property.name='parse']:not([callee.object.name='JSON'])",
  message: 'Call parser.parse only inside src/grammar-engine/with-tree.ts, which deletes every WASM object in finally (PITFALLS B1). JSON.parse is fine.',
};

const dynamicAndRequire = (re, message) => [
  { selector: `ImportExpression[source.value=/${re}/]`, message },
  { selector: `CallExpression[callee.name='require'][arguments.0.value=/${re}/]`, message },
];

/**
 * Complete no-restricted-syntax selector list for a module: dynamic import() and require() forms that
 * no-restricted-imports cannot see.
 * @param {string} mod module directory name under src/
 * @param {{ testContext?: boolean, allowParse?: boolean }} [opts] allowParse is for src/grammar-engine/with-tree.ts only
 */
export function syntaxFor(mod, opts = {}) {
  const testContext = opts.testContext === true;
  const s = [];
  if (mod !== 'command-runner') s.push(...dynamicAndRequire(`^${CP}$`, 'child_process is allowed only in src/command-runner (dynamic import and require included).'));
  if (mod !== 'sqlite') s.push(...dynamicAndRequire(`^${DRIVERS}$`, 'SQLite drivers are allowed only in src/sqlite (dynamic import and require included).'));
  if (!testContext) {
    s.push(...dynamicAndRequire('^node:test', `node:test ${TEST_CODE}.`));
    s.push(...dynamicAndRequire('^\\..*test-kit', `src/test-kit is test code: it ${TEST_CODE}.`));
    s.push(...dynamicAndRequire('^\\..*contract(\\.ts)?$', `Contract suites are test code: a contract.ts file ${TEST_CODE}.`));
  }
  if (mod === 'grammar-engine' && opts.allowParse !== true) s.push(PARSE_SELECTOR);
  return s;
}

const boundaryBlock = (files, mod, opts) => ({
  files,
  rules: {
    'no-restricted-imports': ['error', { patterns: patternsFor(mod, opts) }],
    'no-restricted-syntax': ['error', ...syntaxFor(mod, opts)],
  },
});

export default defineConfig([
  { files: ['src/**/*.ts'], languageOptions: { parser: tseslint.parser } },
  ...MODULES.flatMap((mod) => [
    boundaryBlock([`src/${mod}/**/*.ts`], mod, {}),
    boundaryBlock(TEST_CONTEXT_FILES[mod], mod, { testContext: true }),
  ]),
  // The one file allowed to call parser.parse; it keeps the module's other selectors. Placed after both
  // grammar-engine blocks so it wins.
  {
    files: ['src/grammar-engine/with-tree.ts'],
    rules: { 'no-restricted-syntax': ['error', ...syntaxFor('grammar-engine', { allowParse: true })] },
  },
  // No console output anywhere in src (HST-01, research Pitfall 8): the stdio MCP server's stdout carries
  // protocol frames, so a stray console.log corrupts them, and the CLI writes only through its injected io.
  // A separate block on purpose: it sets a rule no boundary block sets, so it cannot replace their options.
  {
    files: ['src/**/*.ts'],
    rules: { 'no-console': 'error' },
  },
]);
