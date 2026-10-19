# How to contribute a change

This guide checks a change before you propose it. It assumes a clone with your edits, Node 24.16.0 or newer and git on the path. Run the commands from the repository root; each should exit 0.

1. Install the pinned dependencies without running install scripts:

   ```sh
   npm ci --ignore-scripts
   ```

2. Compile `src/` to `dist/`, the layout that is published:

   ```sh
   npm run build
   ```

   It prints nothing when it succeeds.

3. Run the full test suite:

   ```sh
   npm test
   ```

   The `test` script is `node --test` over `src/**/*.test.ts` and `scripts/**/*.test.ts`. It also removes and rebuilds `dist/`, packs the tarball and installs it into a clean folder, and that install fetches the exact-pinned runtime dependencies from the package registry, so it needs network access. To run one test file, give `node --test` the path of that file in place of the two patterns.

4. Run the static checks:

   ```sh
   npm run lint
   npm run typecheck
   npm run schema:check
   ```

   `lint` runs ESLint over `src`, `typecheck` runs `tsc` without emitting, and `schema:check` prints `schemas/atlas-lang.schema.json is current.` when the committed schema matches the manifest source.

5. Check the parse-error budget over the grammar fixtures:

   ```sh
   npm run grammar:budget
   ```

   It prints one line per module, such as `typescript: errorBytes 0 totalBytes 4739 ratio 0.000000 budget 0.005 OK`, and exits 1 when a ratio is strictly above its budget (0.5 percent by default).

6. Rebuild the grammars and compare them with `grammar.lock`:

   ```sh
   node scripts/ensure-tree-sitter.ts
   npm run grammar:verify
   ```

   The first command downloads the tree-sitter command-line release binary that `npm ci --ignore-scripts` leaves out, and checks that its version equals the pinned one. `grammar:verify` builds every grammar module twice from source, and requires the two builds to agree with each other and with this platform's entry in the module's `grammar.lock`, and the committed `grammar.wasm` to match its recorded hash. The build uses the network and the wasi toolchain. A passing run prints `<module>: verified <platform> rebuild sha256 ...` for each module.

7. Run the walking skeleton and list the modules:

   ```sh
   node dist/bin/gsd-atlas.js lang test test/fixtures/modules/toy
   node dist/bin/gsd-atlas.js lang list
   ```

   Each prints one JSON envelope on stdout. `lang test` checks the toy module against its golden files and exits 0 when `ok` is `true`; it exits 1 for an unknown module and 2 for a failed check. `lang list` shows which modules were found and where each came from.

The change has to clear the same checks in continuous integration: Node 24.16.0 and 26 on Linux and macOS run the build, the tests and the parse-error budget; the Windows jobs run too but do not block (Windows is postponed past the alpha); Node 24.16.0 on Linux runs lint, typecheck and the schema check; the grammar rebuild and the measured gates block on Linux and macOS and have a Windows leg that does not block, and you can run the gates yourself (see [How to run the measured gates locally](run-the-measured-gates-locally.md)).

## If `grammar:verify` reports a mismatch

It prints `grammar verify failed for <module> on <platform>`, then the hash expected from `grammar.lock`, the hashes of the first and second rebuild, and the expected and actual hash of the committed `grammar.wasm`. Two rebuilds that differ from each other mean the build is not reproducible here; a rebuild that differs from the lock entry or a committed file that differs from its recorded hash means the grammar or its lock changed. A platform with no entry in `grammar.lock` fails and names the platform; `npm run grammar:build -- --update-platform` records this platform's rebuild hash.

## If `schema:check` reports drift

It prints `schemas/atlas-lang.schema.json is out of date with src/lang/manifest.ts. Run: npm run schema:build`. Run `npm run schema:build`, then commit the regenerated schema.

## If `npm test` fails at the pack or install step

That step needs the registry. Check that you can reach it, then run `npm test` again.

For the `lang` commands and their exit codes, see [the CLI reference](../reference/cli.md).
