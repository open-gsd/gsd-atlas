# gsd‑atlas — SDK providers and language levels for open toolchains

**Status:** Research · 2026‑10‑15 · companion to `PRD.md` §7 and `DESIGN.md` A29–A31

Agents guess at APIs and syntax from training data. For Apple platforms the fix is the installed Xcode SDK (PRD §7.2). This document covers languages whose toolchains are open source rather than tied to one vendor's OS: JavaScript, TypeScript, C, C++, C#, Java, Python, Go and Rust. For each, it answers three questions:

1. **What level does the project target?** (language standard, runtime or library version)
2. **What APIs exist at that level, and since when?** (the "SDK facts")
3. **What syntax is allowed at that level?** (the "language level")

Every answer comes from files already installed with the toolchain wherever possible. "Verified" means it was checked in a sandbox on 2026‑10‑15.

---

## 1. Summary

| Language | Project level read from | Local API source | "Since" data | Verified |
|----------|------------------------|------------------|--------------|----------|
| **JavaScript (browsers)** | `browserslist` (package.json or `.browserslistrc`) | TypeScript `lib.dom.d.ts` and `lib.es20xx.d.ts` | [`@mdn/browser-compat-data`](https://www.npmjs.com/package/@mdn/browser-compat-data) (CC0): `version_added` per browser, Node and Deno | Yes |
| **JavaScript/TypeScript on Node** | `engines.node`, `.nvmrc`, `.node-version` | Repo's `@types/node` | BCD `nodejs` entries; `@types/node` major version | Yes |
| **TypeScript (language)** | Installed `typescript` version; tsconfig `target` and `lib` | `lib.*.d.ts` shipped with the compiler | Lib file names map APIs to ECMAScript editions (`lib.es2024.collection.d.ts`) | Yes |
| **C** | `-std=` from `compile_commands.json`; libc identity (glibc, musl, Apple libc) | System headers parsed by clang | glibc symbol versions (`objdump -T libc.so.6`); `__STDC_VERSION__` guards; Apple availability attributes | Yes |
| **C++** | `-std=` from `compile_commands.json`; standard library (libstdc++, libc++, MSVC STL) | Standard library headers parsed by clang | Feature‑test macros from `<version>` (`__cpp_lib_*`) | Yes |
| **C# / .NET** | `TargetFramework`, `LangVersion` in the project file | Reference assemblies in `dotnet/packs/Microsoft.NETCore.App.Ref/<ver>/ref/<tfm>/` | Diff reference packs across target frameworks | Yes (pack contents) |
| **Java** | `maven.compiler.release`, Gradle toolchain, `--release` | JDK `lib/ct.sym` | `ct.sym` holds API signatures for each past release (what `javac --release` uses); `@since` tags in `lib/src.zip` | Yes |
| **Python** | `requires-python` in pyproject; `.python-version` | typeshed stdlib stubs (bundled in pyright and mypy) | `stdlib/VERSIONS` (module ranges) plus `sys.version_info` guards in stubs (member level) | Yes |
| **Go** | `go` and `toolchain` directives in go.mod | `$GOROOT/src` | `$GOROOT/api/go1.N.txt`: every exported API added in each release | Yes |
| **Rust** | `edition` and `rust-version` in Cargo.toml; `rust-toolchain.toml` | `rust-src` component | `#[stable(feature, since = "1.x.0")]` attributes on every stable item | Yes |

---

## 2. Per‑language detail

### JavaScript in browsers
- **API:** TypeScript's `lib.dom.d.ts` and `lib.es20xx.d.ts` declare web and language APIs, with JSDoc summaries.
- **Since:** MDN's browser‑compat‑data (BCD) is a CC0 npm package with `version_added` for each API per browser, Node and Deno. Verified with 8.1.6: `Array.prototype.toSorted` → Chrome 110, Safari 16, Node 20.0.0, Deno 1.31; `fetch` → Node 18.0.0.
- **Availability is multi‑target:** a browser project targets several engines at once, so availability is stored per axis (Chrome, Safari, Firefox, Node…), not as one version.
- **Note:** BCD releases often (8.1.6 was published 2026‑10‑15). The provider records the BCD version it read, so answers say which data they used.

### Node, Deno, Bun
- **Node:** the repo's `@types/node` (declarations + JSDoc) plus BCD's `nodejs` entries for since data.
- **Deno and Bun:** the same provider shape over their own declaration files (`deno types` output; the `bun-types` package). Not verified here.

### TypeScript (language)
- The compiler ships its own lib files. TypeScript 7.0.2 (the native compiler, published 2026‑07‑08) ships 108 `lib.*.d.ts` files in its platform package.
- **TypeScript 7 changes the compiler API.** 7.0 exposes its API as `typescript/unstable/sync` and `typescript/unstable/async` (over IPC to the native binary), not the classic `ts.createProgram` JavaScript API. gsd‑core is on TypeScript 6.0.3, which still has the classic API. The TypeScript module needs one adapter for each (DESIGN.md A31).

### C
- **API:** system headers, parsed with `clang -fsyntax-only -Xclang -ast-dump=json` using the project's flags from `compile_commands.json` (command opt‑in, A9).
- **Since:** depends on the C library:
  - **glibc:** symbol versions in the shared library. Verified: `memfd_create` GLIBC_2.27, `arc4random` GLIBC_2.36, `strlcpy` GLIBC_2.38.
  - **Standard C:** `__STDC_VERSION__` guards in headers mark C11/C17/C23 additions.
  - **Apple libc:** `__attribute__((availability(...)))` in the SDK headers (Apple provider).
- **Prose docs:** local man pages (`man 3`) when installed.

### C++
- **API:** standard library headers parsed by clang, as for C.
- **Since:** feature‑test macros in `<version>`. Verified: g++ 13 with `-std=c++23` defines 169 `__cpp_lib_*` macros, for example `__cpp_lib_ranges 202202L` and `__cpp_lib_expected 202211L`. Each value maps to the standard revision that introduced the feature, and the set tells you what this compiler's library actually implements.
- **Precise tier:** scip‑clang with `compile_commands.json`.

### C# / .NET
- **API:** reference assemblies in the SDK's reference pack, with an XML doc file beside each assembly. Verified in Microsoft.NETCore.App.Ref 10.0.13: `ref/net10.0/System.Runtime.dll` with `System.Runtime.xml` (7.6 MB of doc comments), and the `<member>` entries carry summaries and parameter docs.
- **Since:** diff the reference packs for each installed target framework (net8.0, net9.0, net10.0). .NET 10 is the current release; .NET 11 is at RC 2.
- **Reading assemblies** needs an ECMA‑335 metadata reader: either a small `dotnet` helper (command opt‑in) or a JavaScript metadata parser. The XML docs are plain XML and need neither.
- **Precise tier:** scip‑dotnet.

### Java
- **API and since:** JDK `lib/ct.sym` stores the public API signatures for each past release; it is what `javac --release N` compiles against. Verified in JDK 21 (10.6 MB, entries for releases 8 to 21). Presence per release gives "since" and "removed" without any network.
- **Prose docs:** Javadoc in `lib/src.zip`, including `@since` tags.
- **Precise tier:** scip‑java (also covers Kotlin and Scala).

### Python
- **API:** typeshed stdlib stubs (Apache‑2.0), bundled with pyright and mypy.
- **Since:** `stdlib/VERSIONS` gives module ranges, and `if sys.version_info >= (3, N):` blocks in stubs give member‑level availability. Verified (pyright 1.1.414): `tomllib: 3.11-`, `graphlib: 3.9-`, `distutils: 3.0-3.11`, and version guards in `itertools.pyi`.
- **Prose docs:** docstrings from the installed interpreter (command opt‑in), since stubs carry signatures, not prose.
- **Precise tier:** scip‑python.

### Go
- **API and since:** every Go install ships `$GOROOT/api/go1.N.txt`, listing each exported API added in that release. Verified with Go 1.24.7: 27 files; `slices.Contains` appears in `go1.21.txt`.
- **Prose docs:** doc comments in `$GOROOT/src`.
- **Precise tier:** scip‑go.

### Rust
- **API and since:** the `rust-src` component (source of `core`, `alloc`, `std`) marks every stable item with `#[stable(feature = "...", since = "1.x.0")]`. Verified with Rust 1.97.0: `Option::is_none_or` since 1.82.0; `get_disjoint_mut` since 1.86.0.
- **Prose docs:** doc comments in `rust-src`. Rustdoc JSON output is nightly‑only, so the provider parses attributes directly.
- **Precise tier:** rust‑analyzer's SCIP output.

---

## 3. Language level and syntax

An agent writing a `match` statement for a project that targets Python 3.9, or `let … else` for Rust 1.60, produces code that won't compile. The project's language level is read alongside the SDK, and syntax is checked against it.

| Language | Level read from | Example features and the level that introduced them |
|----------|-----------------|------------------------------------------------------|
| Python | `requires-python` | `match` statement 3.10 |
| JavaScript | `browserslist`, `engines`, tsconfig `target` | Optional chaining `?.` ES2020 |
| TypeScript | installed compiler version | `satisfies` 4.9 |
| C++ | `-std=` | Designated initializers C++20 |
| C# | `LangVersion` or the target framework's default | Primary constructors for classes C# 12 |
| Java | `--release` | Records 16 |
| Go | `go` directive | Range over function iterators 1.23 |
| Rust | `rust-version`, `edition` | `let … else` 1.65; edition 2024 needs 1.85 |

**How it works:**
- Each module ships `features.json`: feature id → minimum level, and a tree‑sitter query that matches the syntax. tree‑sitter grammars parse the newest syntax, so the query finds the feature regardless of project level.
- `syntax_check` (MCP and CLI) flags any feature above the project's level, with the line and the level it needs.
- When commands are allowed, the real compiler at the project's level is the precise check (`tsc --noEmit`, `go vet`, `cargo check`, `javac --release N`).

---

## 4. Importing SDK facts

Three ways in, in order of preference:

| Way | What it does | Network | Commands |
|-----|--------------|---------|----------|
| **Installed toolchain reader** (default) | Reads the files in §1 directly: `api/go1.N.txt`, `ct.sym`, typeshed `VERSIONS`, reference packs and XML, `rust-src` attributes, `<version>` macros, BCD JSON, `lib.*.d.ts`. | No | No |
| **Built‑in command extractor** (on by default, can be turned off) | gsd‑atlas's own first‑party providers with fixed command lines: `swift symbolgraph-extract` and `xcrun` on macOS, clang AST dumps for C/C++ headers, a `dotnet` metadata helper, interpreter docstrings. | No | Yes, first‑party only (A9) |
| **Third‑party command extractor** (opt‑in) | A module's own command. Allowed only in user‑level config, per repo and per command; repo config can never grant it (trust‑boundaries ADR). | No | Yes |
| **SDK packs** | Imports a read‑only SQLite pack produced by one of the above on another machine (for CI, or an SDK that isn't installed locally). Packs are hash‑pinned and record their source and tool version. | Only to fetch a pack, if allowed | No |

**Normalized result:** every provider writes the same shape: SDK id including build and variant where the platform has them (`ios-27.0-27A266a-device`, `go-1.24.7`, `jdk-21`, `dotnet-10.0.13`, `glibc-2.39`, `libstdcxx-13`, `typeshed-<rev>`, `bcd-8.1.6`); symbol (keyed by a provider-native `symbol_key`: Apple USR, Go `package.Name`, Java descriptor, typeshed `module.name`; meaningful only within one SDK id); kind; signature; availability as one or more axes (one version line for Go, Rust, Java, .NET and Python; several for browsers and Apple OSes) with introduced, deprecated and removed; and doc text only when the local source has it.

Providers are registered by id and selected by the project's targets, not by language module: one provider can serve several languages (Apple: Swift, Objective-C, C; Node/BCD: JavaScript and TypeScript). Availability is stored in its own per-axis table keyed by `(sdk_id, symbol_key)`.

**Licensing:**
- By default only facts (names, signatures, versions) are stored.
- Prose comes only from sources installed on the machine.
- BCD is CC0 and typeshed is Apache‑2.0, so both are safe to depend on.
- Third‑party documentation archives (for example cppreference's offline archive, or MDN prose) are only ever user‑imported packs, never bundled, so their licenses travel with the user's choice.

---

## 5. Third‑party packages (same mechanism)

Hallucinated library APIs are as common as hallucinated platform APIs. The same provider interface reads exact installed dependency versions from lockfiles and local caches, with no network:

| Ecosystem | Version from | Local API source |
|-----------|-------------|------------------|
| npm | `package-lock.json`, `pnpm-lock.yaml` | `node_modules/<pkg>` `.d.ts` files |
| PyPI | `uv.lock`, `poetry.lock`, installed `dist-info` | site‑packages `.pyi`, `py.typed` sources |
| Go | `go.sum` | `$GOMODCACHE` sources |
| Cargo | `Cargo.lock` | `~/.cargo/registry/src` |
| NuGet | `packages.lock.json`, `obj/project.assets.json` | `~/.nuget/packages/<id>/<ver>/lib/<tfm>/*.xml` and `*.dll` |
| Maven/Gradle | lockfiles, resolved dependencies | `~/.m2` sources jars |
| SwiftPM | `Package.resolved` | `.build/checkouts` |

Package facts are keyed by ecosystem, name and the **lockfile integrity hash**, so agents see the API of the exact artifact installed, and patched or git dependencies with the same version string don't collide. Only packages resolved from a public registry go into the machine‑wide shared store; private, scoped‑private, git, workspace and patched packages stay in the repo's own store, so one repo's private code never reaches another repo's agents (A39).

---

## 6. Proposed order

| Phase | Providers | Why |
|-------|-----------|-----|
| 1.0 | Apple, Node + web (BCD, TypeScript lib, `@types/node`) | Launch modules (Swift, TypeScript). |
| 1.1 | Python, Go | Simplest data (`VERSIONS`, `api/go1.N.txt`), no commands needed. |
| 1.2 | Java, Rust | File‑only (`ct.sym`, `rust-src` attributes). |
| 1.3 | C#, C, C++ | Need a metadata reader or clang for best results. |
| 1.x | npm, PyPI, Go, Cargo package facts | Same interface; high value against invented library APIs. |

All of these can also arrive as community modules (A6) before they ship built in.

---

## Sources
- [@mdn/browser-compat-data on npm](https://www.npmjs.com/package/@mdn/browser-compat-data) (8.1.6, CC0‑1.0)
- typescript 7.0.2 and pyright 1.1.414 packages on npm, inspected locally
- Microsoft.NETCore.App.Ref 10.0.13 package from nuget.org, inspected locally
- Go 1.24.7, OpenJDK 21, Rust 1.97.0, GCC 13.3 and glibc toolchains, inspected locally
