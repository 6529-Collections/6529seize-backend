# Backend Package Commands

This repository routes npm installs, package scripts, and local package
binaries through the repo-local `6529` command. The wrapper uses Corepack to
run the npm version pinned by the current package's `packageManager` field.

## Initial Setup

If you use `direnv`, allow the existing repository environment once:

```bash
direnv allow
6529 ci
```

Without `direnv`, bootstrap the repo-scoped command once:

```bash
./bin/6529 bootstrap
```

Open a new shell, source the shell file printed by bootstrap, or activate the
current shell immediately:

```bash
source <(./bin/6529 bootstrap --print-export)
6529 ci
```

The shell hook exposes `6529` and the package-manager guards only while the
current directory is inside this repository. It does not replace the
machine-wide npm installation.

`./bin/6529` remains available without bootstrap when an explicit repo-local
path is preferable, including automation and fresh-clone setup.

## Daily Commands

Run commands from the directory containing the applicable `package.json`:

```bash
6529 ci
6529 add <package>
6529 add -D <package>
6529 remove <package>
6529 update [package]
6529 audit
6529 audit:fix
6529 run <script>
6529 exec <binary>
```

Examples from the repository root:

```bash
6529 run build
6529 run lint
6529 run test
6529 run backend:local
6529 run migrate-local:up
```

`6529 run build` remains the comprehensive developer build: it generates the
deploy configuration, runs the full Jest suite, compiles the backend, and
copies runtime assets. The PR workflow runs those same tests separately with
its controlled shard inventory, then uses the internal `6529 run build:ci`
lifecycle to compile and copy assets without running Jest a second time.
Developers should normally use `6529 run build`, not `build:ci`.

The API has its own package and lockfile, so run API commands from its package
directory:

```bash
cd src/api-serverless
6529 ci
6529 run generate:openapi
6529 run build
```

Independently packaged Lambdas work the same way:

```bash
cd src/transactionsLoop
6529 ci
6529 run build
```

### Media packages

Use Node 22 for the backend and media checks (Sharp requires at least Node
20.9.0). A normal `6529 ci` selects native optional packages for the host.
Do not omit optional dependencies. The media compatibility workflow exercises
Linux x64, macOS Intel/ARM64 and Windows x64 installs using the existing Bash
wrapper convention, plus real codec and multipart tests.

The six Sharp Lambda packages build deployment ZIPs only on Linux x64 with
glibc. On macOS or Windows, use a Linux x64 container or the GitHub deployment
workflow. The build checks the host before removing outputs, explicitly selects
Linux x64/glibc optional packages, ignores global libvips for deployment, and
extracts the final ZIP to verify codecs and handler loading. PR CI repeats this
verification in the official Lambda Node 22 image without network access.

Developer installs may use custom libvips; Sharp 0.35.4 requires libvips >=8.18.6
and such builds are developer-managed. Set `SHARP_IGNORE_GLOBAL_LIBVIPS=1` to
use the tested bundled binaries. Windows ARM64 optional packages remain in the
lockfiles but that developer runtime is not covered by this workflow.

Run the database-independent real-image and upload checks with:

```bash
./bin/6529 exec jest --config scripts/media-jest.config.cjs
./bin/6529 exec node scripts/verify-media-runtime.cjs .
```

For diagnostics, `6529 npm:version` prints the npm version that Corepack
resolves from the current package's `packageManager` pin. It is not required
for normal setup, installs, or script execution.

## Coordinator Release CLI

The root devDependency `@6529-collections/release-request` is pinned to `0.0.4`
from public npm in `package.json` and `package-lock.json`. It requires Node 20
or newer and has no install-time scripts. Normal `./bin/6529 ci` installs it;
no GitHub Packages token or private registry configuration is needed.

From the repository root, inspect the installed version and current template:

```bash
./bin/6529 exec 6529-release-request --version
./bin/6529 exec 6529-release-request template
```

For this CLI, the wrapper directly executes the root package's installed entry
point. It fails if that entry point is missing or not executable, without npm
exec, a PATH fallback, or downloading a replacement. Other `6529 exec` commands
retain their existing behavior.

Follow [Coordinator release recording](../ops/skills/deploy-6529/SKILL.md#coordinator-release-recording)
for authorized submission and outcome handling. The CLI owns its local records
under `.release-coordinator/runs/` and `.release-coordinator/outbox/`; both are
ignored by Git.

## Command Policy

- `6529 ci` is the normal deterministic installation path. It runs
  `corepack npm ci` against the current package without changing its lockfile.
- `6529 add`, `6529 remove`, and `6529 update` are the intentional dependency
  mutation paths.
- `6529 run` replaces direct `npm run` and `npm test` usage.
- `6529 exec` replaces direct `npx` usage.
- Bare `6529 install` and `6529 i` are rejected because they are ambiguous
  between frozen setup and dependency mutation.
- Direct npm, npx, Corepack npm, pnpm, Yarn, and Bun project commands are
  rejected with the corresponding `6529` command to run instead.

Every package manifest carries a lifecycle guard, and package-manager
discipline checks require all package roots to use the pinned npm version and
the same guard. CI and deployment workflows call the wrapper explicitly.

Repository guardrails cannot prevent a machine owner from deliberately
bypassing the repository PATH and disabling lifecycle scripts. The supported
developer, agent, CI, and deployment paths all fail closed on direct package
manager usage.
