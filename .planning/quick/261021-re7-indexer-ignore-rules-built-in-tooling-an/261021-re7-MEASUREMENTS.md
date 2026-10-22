# Quick task 261021-re7: measured defaults for index exclusions

**Status: a measurement and design record, not a decision record.** It feeds the 2026-10-21 amendments of ADRs 3, 4 and 5 that the owner approved. Nothing here is registered, scored or ratified. All numbers were taken on 2026-10-21 on macOS arm64 with git 2.54.0 (Apple Git-157). The registered evaluation result is untouched and frozen.

Tool: `measure-defaults.mjs` in this folder (`--check` validates this file, `--emit-ts` prints the constant of Task 2). Every count is git's own matcher: `git ls-files -z --cached --ignored --exclude <pattern>`. No matcher of ours is used and no corpus, no script and no install of a corpus was run.

## Corpora and pins

| corpus | pin (docs/eval/corpus-candidates.md) | HEAD found | at pin | tracked paths |
| --- | --- | --- | --- | ---: |
| gsd-core | `10ac3a7a94` | `10ac3a7a94` | yes | 3976 |
| gsd-pi | `bb86b6ca2d` | `bb86b6ca2d` | yes | 5787 |
| vscode | `a403d0f7dc` | `a403d0f7dc` | yes | 20991 |
| TypeScript | `98add1bbed` | `98add1bbed` | yes | 67927 |
| angular | `3cc1edf321` | `3cc1edf321` | yes | 11699 |
| excalidraw | `1d4dc2c0e6` | `1d4dc2c0e6` | yes | 1320 |
| backstage | `53d5be1782` | `53d5be1782` | yes | 12313 |
| n8n | `58f11bf0cf` | `58f11bf0cf` | yes | 32234 |
| nest | `62647d3ec9` | `62647d3ec9` | yes | 2590 |
| vue-core | `65eae17838` | `65eae17838` | yes | 703 |
| material-ui | `2a8f217d79` | `2a8f217d79` | yes | 41537 |
| strapi | `487dc3ff16` | `487dc3ff16` | yes | 7147 |
| grafana | `0be7d5b210` | `0be7d5b210` | yes | 23923 |
| svelte | `2334f5ed0b` | `2334f5ed0b` | yes | 9270 |
| apollo-client | `c4aeadcd44` | `c4aeadcd44` | yes | 1163 |

Pinned gsd-core: the clone at `~/projects/gsd-core` is NOT at the pin, so its tree at `10ac3a7a947903ba50f538a907af036744d759d5` was read into a temporary index file under the scratchpad (`GIT_INDEX_FILE` plus `read-tree`) and every listing ran with that variable; the clone's own index and work tree were never written. The other 14 corpora are the read-only shallow clones under the scratchpad corpora folder, each at the pin of `docs/eval/corpus-candidates.md` (the "at pin" column).

## Tracked-path drops per entry

Each cell is `dropped/source-extension` for `ls-files -z --cached --ignored --exclude <pattern>`. The last column is the sum of source-extension paths over all measured corpora.

| pattern | gsd-core | gsd-pi | vscode | TypeScript | angular | excalidraw | backstage | n8n | nest | vue-core | material-ui | strapi | grafana | svelte | apollo-client | total src |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `node_modules/` | 0/0 | 0/0 | 1/0 | 0/0 | 0/0 | 0/0 | 36/28 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 28 |
| `bower_components/` | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0 |
| `jspm_packages/` | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0 |
| `.pnpm-store/` | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0 |
| `.yarn/cache/` | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0 |
| `.npm/` | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0 |
| `dist/` | 0/0 | 5/3 | 1/0 | 0/0 | 5/4 | 0/0 | 27/16 | 5/5 | 0/0 | 0/0 | 0/0 | 2/2 | 7/0 | 0/0 | 0/0 | 30 |
| `build/` | 0/0 | 0/0 | 506/297 | 9/9 | 4/4 | 0/0 | 2/2 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 410/208 | 0/0 | 0/0 | 520 |
| `out/` | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0 |
| `.next/` | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0 |
| `.nuxt/` | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0 |
| `.svelte-kit/` | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0 |
| `.turbo/` | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0 |
| `.parcel-cache/` | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0 |
| `.cache/` | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0 |
| `coverage/` | 0/0 | 0/0 | 2/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0 |
| `.nyc_output/` | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0 |
| `.angular/` | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0 |
| `.vite/` | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0 |
| `__pycache__/` | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0 |
| `.venv/` | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0 |
| `.tox/` | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0 |
| `.mypy_cache/` | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0 |
| `.pytest_cache/` | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0 |
| `*.egg-info/` | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0 |
| `target/` | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 3/3 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 3 |
| `.gradle/` | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0 |
| `.mvn/` | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0 |
| `Pods/` | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 33/31 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 31 |
| `DerivedData/` | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0 |
| `.build/` | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0 |
| `.swiftpm/` | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0 |
| `*.min.js` | 0/0 | 2/2 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 2 |
| `*.min.css` | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0 |
| `*.bundle.js` | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0 |
| `*.js.map` | 0/0 | 0/0 | 0/0 | 152/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 1/0 | 0/0 | 0/0 | 0 |
| `*.css.map` | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0 |

### Sample dropped paths (up to five per entry and corpus, source-extension paths first)

- `node_modules/` in vscode: 1 dropped, 0 source-extension; e.g. `extensions/css-language-features/server/test/linksTestFixtures/node_modules/foo/package.json`
- `node_modules/` in backstage: 36 dropped, 28 source-extension; e.g. `packages/backend-dynamic-feature-service/src/features/__fixtures__/dynamic-plugins-root-for-bundled/test-backend-bundled-dynamic/node_modules/@backstage/backend-plugin-api/index.js`, `packages/backend-dynamic-feature-service/src/features/__fixtures__/dynamic-plugins-root/test-backend-dynamic/node_modules/private-dep-with-frontend-plugin-index-path/index.js`, `packages/backend-dynamic-feature-service/src/features/__fixtures__/node_modules/@backstage/backend-plugin-api/index.js`, `packages/cli-module-build/src/tests/transforms/__fixtures__/node_modules/dep-commonjs/a-default.js`, `packages/cli-module-build/src/tests/transforms/__fixtures__/node_modules/dep-commonjs/a-named.js`
- `dist/` in gsd-pi: 5 dropped, 3 source-extension; e.g. `pkg/dist/core/export-html/template.js`, `pkg/dist/core/export-html/vendor/highlight.min.js`, `pkg/dist/core/export-html/vendor/marked.min.js`
- `dist/` in vscode: 1 dropped, 0 source-extension; e.g. `test/monaco/dist/core.html`
- `dist/` in angular: 5 dropped, 4 source-extension; e.g. `ngp-vscode-ng-language-service/tests/test-workspace/mock_packages/@angular/core/third_party/@mcp-b/webmcp-types/dist/common.d.ts`, `ngp-vscode-ng-language-service/tests/test-workspace/mock_packages/@angular/core/third_party/@mcp-b/webmcp-types/dist/json-schema.d.ts`, `packages/compiler-cli/preprocessor/language-service/tests/test-workspace/mock_packages/@angular/core/third_party/@mcp-b/webmcp-types/dist/common.d.ts`, `packages/compiler-cli/preprocessor/language-service/tests/test-workspace/mock_packages/@angular/core/third_party/@mcp-b/webmcp-types/dist/json-schema.d.ts`
- `dist/` in backstage: 27 dropped, 16 source-extension; e.g. `packages/backend-dynamic-feature-service/src/features/__fixtures__/dynamic-plugins-root-for-alpha-fallback/test-backend-alpha-fallback-dynamic/dist/alpha.cjs.js`, `packages/backend-dynamic-feature-service/src/features/__fixtures__/dynamic-plugins-root-for-alpha-fallback/test-backend-alpha-fallback-dynamic/dist/index.cjs.js`, `packages/backend-dynamic-feature-service/src/features/__fixtures__/dynamic-plugins-root-for-alpha/test-backend-alpha-dynamic/dist/alpha.cjs.js`, `packages/backend-dynamic-feature-service/src/features/__fixtures__/dynamic-plugins-root-for-alpha/test-backend-alpha-dynamic/dist/index.cjs.js`, `packages/backend-dynamic-feature-service/src/features/__fixtures__/dynamic-plugins-root-for-bundled/test-backend-bundled-dynamic/dist/index.cjs.js`
- `dist/` in n8n: 5 dropped, 5 source-extension; e.g. `packages/quality/testing/playwright/fixtures/community-packages/packages/n8n-nodes-compat-legacy-1.0.0/dist/CompatProbe.node.js`, `packages/quality/testing/playwright/fixtures/community-packages/packages/n8n-nodes-compat-legacy-2.0.0/dist/CompatProbe.node.js`, `packages/quality/testing/playwright/fixtures/community-packages/packages/n8n-nodes-compat-malformed-1.0.0/dist/CompatProbe.node.js`, `packages/quality/testing/playwright/fixtures/community-packages/packages/n8n-nodes-compat-v1-1.0.0/dist/CompatProbe.node.js`, `packages/quality/testing/playwright/fixtures/community-packages/packages/n8n-nodes-compat-v3-1.0.0/dist/CompatProbe.node.js`
- `dist/` in strapi: 2 dropped, 2 source-extension; e.g. `.github/actions/check-pr-status/dist/index.js`, `.github/actions/community-pr-triage/dist/index.cjs`
- `dist/` in grafana: 7 dropped, 0 source-extension; e.g. `pkg/plugins/manager/testdata/app-with-child/dist/MANIFEST.txt`, `pkg/plugins/manager/testdata/app-with-child/dist/child/plugin.json`, `pkg/plugins/manager/testdata/app-with-child/dist/plugin.json`, `pkg/plugins/manager/testdata/plugin-with-dist/plugin/dist/MANIFEST.txt`, `pkg/plugins/manager/testdata/plugin-with-dist/plugin/dist/plugin.json`
- `build/` in vscode: 506 dropped, 297 source-extension; e.g. `build/agent-sdk/common.ts`, `build/agent-sdk/package.ts`, `build/agent-sdk/produce.ts`, `build/agent-sdk/test/versionSync.test.ts`, `build/agent-sdk/upload.ts`
- `build/` in TypeScript: 9 dropped, 9 source-extension; e.g. `tsc/internal/execute/build/buildtask.go`, `tsc/internal/execute/build/buildtask_contentmapper_test.go`, `tsc/internal/execute/build/clean_test.go`, `tsc/internal/execute/build/compilerHost.go`, `tsc/internal/execute/build/graph_test.go`
- `build/` in angular: 4 dropped, 4 source-extension; e.g. `scripts/build/angular-in-memory-web-api.mts`, `scripts/build/build-packages-dist.mts`, `scripts/build/package-builder.mts`, `scripts/build/zone-js-builder.mts`
- `build/` in backstage: 2 dropped, 2 source-extension; e.g. `packages/cli-module-build/src/commands/package/build/command.ts`, `packages/cli-module-build/src/commands/package/build/index.ts`
- `build/` in grafana: 410 dropped, 208 source-extension; e.g. `pkg/build/wire/_tutorial/main.go`, `pkg/build/wire/_tutorial/wire.go`, `pkg/build/wire/_tutorial/wire_gen.go`, `pkg/build/wire/cmd/wire/main.go`, `pkg/build/wire/internal/wire/analyze.go`
- `coverage/` in vscode: 2 dropped, 0 source-extension; e.g. `src/vs/platform/agentHost/test/node/e2e/coverage/protocol-surface.json`, `src/vs/platform/agentHost/test/node/e2e/coverage/summary.json`
- `target/` in n8n: 3 dropped, 3 source-extension; e.g. `packages/@n8n/typeorm/test/functional/entity-schema/target/entity-schema-target.ts`, `packages/@n8n/typeorm/test/functional/entity-schema/target/entity/PostEntity.ts`, `packages/@n8n/typeorm/test/functional/entity-schema/target/model/Post.ts`
- `Pods/` in backstage: 33 dropped, 31 source-extension; e.g. `plugins/kubernetes-react/src/components/Pods/ErrorList/ErrorList.test.tsx`, `plugins/kubernetes-react/src/components/Pods/ErrorList/ErrorList.tsx`, `plugins/kubernetes-react/src/components/Pods/ErrorList/index.ts`, `plugins/kubernetes-react/src/components/Pods/Events/Events.test.tsx`, `plugins/kubernetes-react/src/components/Pods/Events/Events.tsx`
- `*.min.js` in gsd-pi: 2 dropped, 2 source-extension; e.g. `pkg/dist/core/export-html/vendor/highlight.min.js`, `pkg/dist/core/export-html/vendor/marked.min.js`
- `*.js.map` in TypeScript: 152 dropped, 0 source-extension; e.g. `tsc/testdata/baselines/reference/compiler/commonSourceDirectory.js.map`, `tsc/testdata/baselines/reference/compiler/commonSourceDirectory_dts.js.map`, `tsc/testdata/baselines/reference/compiler/contentMapperDeclarationEmit.js.map`, `tsc/testdata/baselines/reference/compiler/contentMapperDeclarationEmitFailure.js.map`, `tsc/testdata/baselines/reference/compiler/contentMapperOutputExtensions.js.map`
- `*.js.map` in grafana: 1 dropped, 0 source-extension; e.g. `pkg/api/frontendlogging/test-data/foo.js.map`

Argv of the full defaults list as `--exclude <pattern>` pairs: 781 bytes (limit in the plan: 8192).

## Per-entry decision

Rule (mechanical, stated before the table). A directory entry is TRACKED-OK if and only if it drops zero tracked source-extension paths (`.ts .tsx .mts .cts .js .jsx .mjs .cjs .py .swift .java .kt .rs .go .c .h .cpp`) in every measured corpus, or at most 3 in total across all corpora with every one listed and a reason written (the logged negligible allowance; no entry used it). Otherwise it is UNTRACKED-ONLY. A bundle-output entry matches by a name that marks a generated or minified artifact, so a tracked drop is its intent: TRACKED-OK unless the samples show hand-written source. An entry whose ecosystem has no measured corpus (python, jvm-rust, apple) is UNTRACKED-ONLY with the reason "not measured".

Meaning. TRACKED-OK: the entry is also applied to tracked files (they leave the index). UNTRACKED-ONLY: the entry only prunes untracked, not-ignored files; a tracked file under it stays indexed. Result: 21 of 37 entries are TRACKED-OK, 16 are UNTRACKED-ONLY.

| pattern | ecosystem | decision | reason |
| --- | --- | --- | --- |
| `node_modules/` | javascript | UNTRACKED-ONLY | 28 tracked source-extension paths dropped, all in backstage test fixtures that deliberately commit a fake node_modules tree (above the allowance of 3); installed packages are untracked, so the untracked scope is the whole point. |
| `bower_components/` | javascript | TRACKED-OK | Zero tracked paths dropped in all 15 corpora. |
| `jspm_packages/` | javascript | TRACKED-OK | Zero tracked paths dropped in all 15 corpora. |
| `.pnpm-store/` | javascript | TRACKED-OK | Zero tracked paths dropped in all 15 corpora. |
| `.yarn/cache/` | javascript | TRACKED-OK | Zero tracked paths dropped in all 15 corpora (anchored at the repository root, where Yarn keeps it). |
| `.npm/` | javascript | TRACKED-OK | Zero tracked paths dropped in all 15 corpora. |
| `dist/` | javascript | UNTRACKED-ONLY | 30 tracked source-extension paths dropped in gsd-pi, angular, backstage, n8n and strapi (committed action bundles, test fixtures, mock packages); above the allowance of 3. |
| `build/` | javascript | UNTRACKED-ONLY | 520 tracked source-extension paths dropped, mostly hand-written code in a directory called build (vscode build scripts, grafana pkg/build, angular scripts/build, TypeScript tsc/internal/execute/build). |
| `out/` | javascript | TRACKED-OK | Zero tracked paths dropped in all 15 corpora. |
| `.next/` | javascript | TRACKED-OK | Zero tracked paths dropped in all 15 corpora. |
| `.nuxt/` | javascript | TRACKED-OK | Zero tracked paths dropped in all 15 corpora. |
| `.svelte-kit/` | javascript | TRACKED-OK | Zero tracked paths dropped in all 15 corpora. |
| `.turbo/` | javascript | TRACKED-OK | Zero tracked paths dropped in all 15 corpora. |
| `.parcel-cache/` | javascript | TRACKED-OK | Zero tracked paths dropped in all 15 corpora. |
| `.cache/` | javascript | TRACKED-OK | Zero tracked paths dropped in all 15 corpora. |
| `coverage/` | javascript | TRACKED-OK | Zero tracked source-extension paths dropped; the only tracked drops are 2 JSON reports in vscode (src/vs/platform/agentHost/test/node/e2e/coverage/), not source. |
| `.nyc_output/` | javascript | TRACKED-OK | Zero tracked paths dropped in all 15 corpora. |
| `.angular/` | javascript | TRACKED-OK | Zero tracked paths dropped in all 15 corpora. |
| `.vite/` | javascript | TRACKED-OK | Zero tracked paths dropped in all 15 corpora. |
| `__pycache__/` | python | UNTRACKED-ONLY | Ecosystem not measured: no Python corpus (all 15 are TypeScript or JavaScript). |
| `.venv/` | python | UNTRACKED-ONLY | Ecosystem not measured: no Python corpus (all 15 are TypeScript or JavaScript). |
| `.tox/` | python | UNTRACKED-ONLY | Ecosystem not measured: no Python corpus (all 15 are TypeScript or JavaScript). |
| `.mypy_cache/` | python | UNTRACKED-ONLY | Ecosystem not measured: no Python corpus (all 15 are TypeScript or JavaScript). |
| `.pytest_cache/` | python | UNTRACKED-ONLY | Ecosystem not measured: no Python corpus (all 15 are TypeScript or JavaScript). |
| `*.egg-info/` | python | UNTRACKED-ONLY | Ecosystem not measured: no Python corpus (all 15 are TypeScript or JavaScript). |
| `target/` | jvm-rust | UNTRACKED-ONLY | Ecosystem not measured: no JVM or Rust corpus; the TypeScript corpora already show 3 tracked source files dropped (n8n typeorm test folder target/). |
| `.gradle/` | jvm-rust | UNTRACKED-ONLY | Ecosystem not measured: no JVM or Rust corpus. |
| `.mvn/` | jvm-rust | UNTRACKED-ONLY | Ecosystem not measured: no JVM or Rust corpus. |
| `Pods/` | apple | UNTRACKED-ONLY | Ecosystem not measured: no Apple corpus; the TypeScript corpora already show 31 tracked source files dropped (backstage UI folder components/Pods/). |
| `DerivedData/` | apple | UNTRACKED-ONLY | Ecosystem not measured: no Apple corpus. |
| `.build/` | apple | UNTRACKED-ONLY | Ecosystem not measured: no Apple corpus. |
| `.swiftpm/` | apple | UNTRACKED-ONLY | Ecosystem not measured: no Apple corpus. |
| `*.min.js` | bundle-output | TRACKED-OK | A tracked drop is the intent; the 2 dropped paths (gsd-pi pkg/dist/core/export-html/vendor/highlight.min.js and marked.min.js) are vendored minified libraries (highlight.js v11.9.0, 1,212 lines, 122 KB; marked v15.0.4, 6 lines, 39 KB, both with a library header), not hand-written source. |
| `*.min.css` | bundle-output | TRACKED-OK | Generated by name and zero tracked paths dropped in all 15 corpora. |
| `*.bundle.js` | bundle-output | TRACKED-OK | Generated by name and zero tracked paths dropped in all 15 corpora. |
| `*.js.map` | bundle-output | TRACKED-OK | A source map is generated by name; the 153 tracked drops (TypeScript test baselines 152, grafana test data 1) are not source-extension files. |
| `*.css.map` | bundle-output | TRACKED-OK | Generated by name and zero tracked paths dropped in all 15 corpora. |

## Git behaviour probes

Installed git: `git version 2.54.0 (Apple Git-157)` (macOS 27, APFS). Each probe ran in a throwaway repository under the scratchpad (probe script: `re7-probes.mjs` in the scratchpad, not committed). The Task 2 tests re-run the shapes that production code sends against the installed git on every platform CI uses.

| id | question | result | evidence |
| --- | --- | --- | --- |
| Q1 | `--exclude` as a separate token, `--ignored` and `--cached` accepted | Yes, exit 0 | `ls-files -z --cached --ignored --exclude dist/` listed `dist/tracked.js` and `pkg/dist/t2.js`. |
| Q2 | A default prunes an untracked directory at any depth, without walking it | Yes | `--others --exclude node_modules/` dropped `node_modules/x/i.js` and `pkg/node_modules/y.js`; an unreadable directory `node_modules/locked/` produced a "could not open directory" warning without the exclude and no warning with it, so the directory was not entered. |
| Q3 | `--cached --ignored --exclude` lists tracked paths at any depth and starts no work-tree walk | Yes | Listed `dist/tracked.js` and `pkg/dist/t2.js`; with an unreadable untracked directory present it printed no warning, while `ls-files --others` on the same tree warned. |
| Q4 | `--exclude-per-directory=.atlasignore` honours nested files, negation, `**`, character classes and anchoring, in the untracked and the tracked listing | Yes, both listings | Tracked: `a.txt` and `b.txt` (`[ab].txt`), `docs/one/gen/f.md` (`docs/**/gen/`), `rootonly.txt` (`/rootonly.txt`, but not `sub/rootonly.txt`), `sub/local.txt` (nested file), `x.snap` (`*.snap`, with `!k.snap` re-including `k.snap`). Untracked: `new.ts` and `new.snap` hidden, `u/rootonly.txt` kept. |
| Q5 | A negation of a default in `.atlasignore` or in `.gitignore` re-includes nothing (untracked and tracked) | Confirmed | With `!node_modules/` and `!dist/` in both files and in a nested `.atlasignore`, `--others` with `--exclude node_modules/ --exclude dist/` still hid `node_modules/x/i.js`, `pkg/node_modules/y.js` and `u-dist-parent/dist/z.js`, and `--cached --ignored --exclude dist/` still listed `dist/tracked.js` and `pkg/dist/t2.js`. Command-line excludes win over per-directory files and over `.gitignore`. |
| Q6 | `--exclude-standard` together with `--exclude-per-directory` applies only the later one | Confirmed in both orders | Order standard then per-directory: `new.ts` (hidden by `.gitignore`) was listed and `new.snap` (hidden by `.atlasignore`) was not. Reverse order: the opposite. Hence the two listings of DD-2. |
| Q7 | A symlinked `.atlasignore` is not followed | Confirmed | Exit 0, stderr `warning: unable to access '.atlasignore': Too many levels of symbolic links` (the text is the operating system's), no rule applied (`secret.ts` stayed listed although the link target named it). |
| Q8 | Invalid UTF-8 and a very large file are accepted by git | Confirmed | A file with a valid first line followed by the bytes `ff fe c3 28` was accepted and the first rule applied; a 2,138,901-byte file was accepted, exit 0, in 19 ms. Neither is rejected by git, so the vetting is ours (DD-3). |

## Cost

Median of three runs, wall time of the git processes only, warm file cache, macOS arm64, APFS. Both repositories are scratch copies (gsd-core: `git archive` of the pin into a fresh repository, 3,972 of the 3,976 tracked paths because `git archive` omits `export-ignore` paths; TypeScript: an APFS clone-copy of the corpus clone) with a ten-line `.atlasignore` added; the original clones and `~/projects/gsd-core` were not written. `node .planning/quick/261021-re7-indexer-ignore-rules-built-in-tooling-an/measure-defaults.mjs --cost` reproduces the table.

| repo | tracked | old single listing (`--cached --others --exclude-standard`) | new unignored stage 1 (A_std and D_def, concurrent) | new snapshot stage 1 (T, R_std, D_def, U0, concurrent) | old snapshot (T then others) | R_atl (stage 2, untracked) | argv bytes of all defaults |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| gsd-core (pin, scratch export) | 3,972 | 19 ms | 19 ms | 23 ms | 28 ms | 17 ms | 781 |
| TypeScript (scratch copy) | 67,927 | 69 ms | 510 ms | 238 ms | 86 ms | 68 ms | 781 |

Where the time goes on the 67,927-path tree (separate runs, median of three): `--cached --others --exclude-standard` 74 ms, the same plus all 37 defaults 68 ms (the defaults on the untracked side cost nothing measurable), `--cached` alone 19 ms, `--cached --ignored` with the 5 bundle patterns 18 ms, with the 16 directory patterns 172 ms, with the 21 tracked patterns 289 ms, with the single pattern `node_modules/` 298 ms. So the cost of the tracked scope is not the number of patterns but the first directory-style pattern. The likely cause is that git must resolve the file type of every tracked path to apply a directory-only pattern (an assumption: no system-call trace was taken). It scales with the tracked count: negligible on gsd-core size, a half second on a 68,000-path tree where `unignoredPaths` is called per batch of new watcher paths.

Decision (report, do not tune): keep the design. Recorded as follow-up: cache D_def per index state, or move the tracked scope off the per-batch path, if a big-tree measurement in Task 2 or the field shows it matters. The cost of the stage-2 untracked listing for `.atlasignore` users is within noise of the old listing on both trees (17 ms and 68 ms), which supports accepting T-re7-09.

## Decisions

Each DD of the plan is restated as confirmed or refined by the probes and the measurement.

- **DD-1 (constant): confirmed.** `INDEX_DEFAULT_EXCLUDES` in `src/source-tree/default-excludes.ts` holds the 37 entries of the decision table, with `appliesToTracked` taken from the table (21 true). Two shapes must be supported by the fake beyond the plan's list: a two-segment directory (`.yarn/cache/`) and a `*.` pattern whose suffix contains a dot (`*.min.js`, `*.js.map`); both are plain suffix or path-prefix rules, so DD-6 is extended to "`*` followed by a literal suffix, with or without a trailing `/`". The argv of the whole list is 781 bytes, far below 8 KB.
- **DD-2 (listings): confirmed.** Q6 proves one run cannot apply both ignore sources, so the two-listing intersection stands; Q3 proves the tracked-drop listing is cheap and walk-free; Q5 proves that command-line excludes are applied last-wins ahead of per-directory files, so defaults cannot be undone by `.atlasignore` and need no special handling beyond passing them in both stage-2 runs.
- **DD-3 (vetting, degrade rule): confirmed.** Q7: git itself does not follow a link (it warns and applies nothing), so the confined reader is a second line of defence and the reason for the fixed note. Q8: git accepts invalid UTF-8 and megabytes of rules, so size, NUL and U+FFFD checks are ours. The degrade is for the whole worktree because git reads every per-directory file of the walk (Q4, nested file) and cannot skip one: either every listed `.atlasignore` is trusted or the flag is not sent.
- **DD-4 (no override): confirmed.** Q5 shows the natural mechanism (a negation) cannot re-include a default in any file, so an override would need a separate, user-level channel (`~/.config/gsd-atlas`, trust-boundaries ADR). Reason for not building one now: a repository author could otherwise use a hostile `.atlasignore` to flood the index with a vendored tree (T-re7-05); the owner decided repo-level only. An untracked file under a default-excluded directory is therefore never indexed; a tracked one is indexed for the UNTRACKED-ONLY entries.
- **DD-5 (diagnostics): unchanged.** Two info notes with counts above zero and one warning, all without a subject.
- **DD-6 (fake): refined as in DD-1.** A test proves every default is a form the fake supports.
- **Measurement finding that shapes the user documentation.** Tracked committed fixtures that mimic `node_modules`, `dist` or `build` are common (backstage, n8n, angular, strapi, gsd-pi, vscode, grafana); applying those three entries to tracked files would have dropped 578 tracked source-extension paths. They stay UNTRACKED-ONLY, which is why `node_modules`, `dist` and `build` do not leave a repository that commits them on purpose.

## Enumeration outside Source Tree

Re-verified on 2026-10-21 with CodeGraph (`parseConfig`, `walk`) and a search of every non-test file under `src/` and `scripts/` for directory reads, `ls-files`, `ls-tree`, `listDirectory`, watcher subscriptions and compiler program creation.

| place | what it enumerates | changed by this plan | note |
| --- | --- | --- | --- |
| `src/precise-resolver/typescript/worker.ts` `parseConfig` (line 157) and `createProgram` (line 200) | the compiler's own tsconfig `include` walk through `api.sys` | no, on purpose | TypeScript's own default excludes apply; types still resolve from `node_modules` and workspace declarations. |
| `src/project-model` (`typescript.ts`, `tsconfig.ts`, `globs.ts`) | works on overlay paths plus the confined reader and `exists` | no | A tsconfig file under an excluded directory is not found by discovery; an `extends` into `node_modules` still resolves through `readText`. `globs.ts` already exports a constant named `DEFAULT_EXCLUDES` (TypeScript's own three package folders), which is why the new constant is `INDEX_DEFAULT_EXCLUDES`. |
| `src/host/history.ts`, `src/source-tree/real.ts` line 378 (`ls-tree -r -z --full-tree <commit>`) | all blobs of a commit | no (follow-up) | `ls-tree` cannot apply exclude patterns; bounded today by `HISTORY_MAX_FILES`. |
| `src/tenant/adr.ts` line 141 (`listDirectory` of ADR directories) | explicit confined directory listing | no, on purpose | Not an index listing. |
| `src/source-tree/list-directory.ts` line 97 (`opendir`) | the implementation behind `SourceTree.listDirectory` | no | Same as the row above; `readText` and `listDirectory` are not subject to the exclusions. |
| `src/indexer/parcel-source.ts`, `src/indexer/worktrees.ts`, `src/indexer/event-source.ts` | watcher subscriptions of the worktree and of git directories | no (follow-up) | Events from excluded directories are dropped by the `PathFilter`; ignore globs for the watcher are a performance follow-up. |
| `src/tenant/follower-overlay.ts` ensureFresh | hashes agent-named paths without an ignore verdict (also for `.gitignore` today) | yes, Task 2 GREEN-2 | |
| `src/lang/registry.ts`, `src/lang/test-runner.ts`, `src/fact-store/recovery.ts`, `src/diagnostics/reports.ts`, `src/diagnostics/io.ts` | module, fixture, store and report directories | no | Not repository files. |
| `src/cli/diagnostics.ts` `walk` (line 170) | none: a prompt loop over diagnostic types | no | Found by the search, not a file walk. |
| `scripts/` (not the evaluation folder): `module-goldens.ts`, `precise-gate.ts`, `edge-sample.ts`, `adr.ts`, `project-model-differential.ts`, `toy-goldens.ts`, `grammar-build.ts`, `corpus-gates.ts`, `grammar-budget.ts`, `relations-check.ts`, `recall.ts`, `adr-citations-check.ts`, `probes/run-payload.ts`, `corpus-survey/survey.ts`, `cleanroom/*`, `angular-pilot/census.ts`, `angular-pilot/oracle-lib.ts`, `angular-pilot/sample-keys.ts` | their own directory reads or `ls-files` | no | Tooling and measurement scripts that enumerate files themselves; out of scope (and the evaluation scripts are not to be touched). |

## Effect on the angular pilot and the gsd-core corpus

- **angular at `3cc1edf3210a9debb0be57a4e99e53a54505db32` (11,699 tracked paths).** The 21 TRACKED-OK entries drop **0** tracked paths. The UNTRACKED-ONLY entries match 5 tracked paths under `dist/` (4 source-extension, mock packages in the language-service tests) and 4 under `build/` (4 source-extension, `scripts/build/*.mts`), which stay indexed because those entries do not apply to tracked files. The angular index set therefore does not change for a fresh clone. The pilot plan prepares the checkout with `git archive` and no install, so there is no `node_modules` or build output to prune; the defaults change nothing for it. `docs/eval/angular-pilot-plan.md` was not edited.
- **gsd-core at the pin `10ac3a7a947903ba50f538a907af036744d759d5` (3,976 tracked paths).** All 37 entries drop **0** tracked paths (the gsd-core column of the drops table is `0/0` throughout). A prepared gsd-core checkout with an installed `node_modules` has untracked packages that the defaults now prune; that changes future runs only. The registered result `OVERALL: MVP not met` is frozen and unaffected: no registered number is recomputed.
- Across the 14 other corpora the only tracked source-extension paths that a TRACKED-OK entry drops are the 2 vendored minified libraries of gsd-pi (`*.min.js`).

## Not measured

- Corpora absent: none; all 15 were present and at their pins.
- Ecosystems with no corpus: Python, JVM, Rust and Apple (Swift, Objective-C) entries. Their tracked scope is UNTRACKED-ONLY by rule; real Python, Gradle, Cargo and Xcode repositories were not surveyed. `target/` and `Pods/` already show false drops in TypeScript corpora, which is evidence for keeping them untracked-only.
- Untracked cruft in general: shallow clones carry none, so the numbers say what the entries do to tracked files, not how much untracked bulk they prune.
- Windows and Linux git timing and behaviour: all probes and costs are macOS arm64, git 2.54.0; the three-OS CI run in Task 2 is the check for the allowlist shapes, and the symlink warning text and permission-based probes (Q2, Q3, Q7) differ by operating system.
- Cost with a large un-ignored `node_modules` on disk: the cost runs use the clean checkouts only.
- Index time effect inside the Indexer (hash count saved): not measured here.

## gsd-core clone integrity

- before: `git status --porcelain` 2 line(s) (sha 2809555bb4cc), `.git/index` sha256 02aab54d961ac3e4a9f4ac723543dba02596ed378a09b1a64cc69ef5ad6283f3
- after:  `git status --porcelain` 2 line(s) (sha 2809555bb4cc), `.git/index` sha256 02aab54d961ac3e4a9f4ac723543dba02596ed378a09b1a64cc69ef5ad6283f3 (taken after the last command of this task, the cost run)
- identical: yes (the two status lines were present before this task and are not ours)
