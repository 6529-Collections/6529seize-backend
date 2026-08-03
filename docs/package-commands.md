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

For diagnostics, `6529 npm:version` prints the npm version that Corepack
resolves from the current package's `packageManager` pin. It is not required
for normal setup, installs, or script execution.

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
