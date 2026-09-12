# C2PA installer patch

This is an installation-only patch of Adobe's MIT-licensed
[`@contentauth/c2pa-node` 0.9.5](https://github.com/contentauth/c2pa-js/tree/%40contentauth%2Fc2pa-node%400.9.5/packages/c2pa-node).
The installed npm package keeps its upstream name and version `0.9.5` for import
compatibility and upstream advisory matching. Its `x-6529-patch` metadata and
archive filename identify packaging revision `0.9.5-6529.1`. Adobe's licence and
the complete published SDK and Rust sources are retained with their original
bytes. This is a locally maintained patch, not an upstream release.

## Scope

- Replace the installer-only `unzipper` dependency with exact `yauzl` 3.4.0.
  The reader, signer, verification settings and native SDK code are unchanged.
- Download the matching official native release ZIP, check its pinned size and
  SHA-256 before parsing, and extract only the expected regular-file member.
  Validate the extracted native binary's size and SHA-256 before replacing
  `dist/index.node`. Downloads and extraction have time and size bounds.
- Preserve the previous binary on failure; reuse an existing binary only after
  checking its size and SHA-256. Unsupported platforms fail installation.
- Remove a publisher's bundled platform binary from the npm archive, if present.
  Every platform uses the verified binary selected by the new installer.
- Do not support the upstream installer's environment-based skips, arbitrary
  library-download overrides or automatic local Rust compilation. The upstream
  runtime API is retained. Our application does not configure an alternate
  native-library path.

## Reproduction and review

`upstream.json` pins the official npm archive by SHA-512. `native-assets.json`
pins the official release URLs and archive/member sizes and SHA-256 values.
GitHub release tags and assets can be changed; a changed download fails the
checked-in digest rather than silently selecting new native code.

From the repository root:

```sh
python3 scripts/build-c2pa-package.py
python3 scripts/build-c2pa-package.py --check
```

The generator never executes the downloaded package. It makes a deterministic
tarball and a file-by-file `contents.json` receipt, asserting byte equality for
every unchanged upstream member. `--upstream-archive PATH` accepts a previously
downloaded copy and still verifies its pinned integrity. The tarball is checked
in so ordinary frozen npm installs do not require Python or a generator step.
Root and worker lockfiles expose the replacement's transitive dependencies to
normal dependency analysis; no Snyk ignore or vulnerability policy is changed.
Native Rust dependency advisories still need upstream SDK/release review; an npm
dependency scan alone does not establish that native code has no vulnerabilities.

The media compatibility workflow checks reproduction, installer regressions,
native readers on Linux x64, macOS Intel/ARM64 and Windows x64, and the deployed
worker ZIP in the Lambda Node 22 image. Linux ARM64 has a pinned upstream asset;
that platform is not included in the native CI matrix.

For an upgrade, inspect the new upstream package and release assets, update the
pins and installer deliberately, regenerate this artifact and both consumer
lockfiles through the repository's `6529` wrapper, and rerun those checks.
Remove the patch when an upstream release supplies a suitable installer.
