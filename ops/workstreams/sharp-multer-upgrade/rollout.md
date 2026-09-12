# Sharp and Multer rollout

Scope: Sharp 0.35.4 in root and six media packages; Multer 2.3.0 in API;
Linux x64/glibc packaging guards and final-artifact/native-platform checks.
No upload policy, API contract, database or frontend changes.

## Deployment order

Staging: artworkDocumentationProcessor → dropMediaSanitizer →
nftLinkMediaPreviewLoop → s3Uploader → rememesLoop → api.
Production: same order, with mediaResizerLoop after rememesLoop and before api.
The storage/schema prerequisites already exist; this change needs no migration
or storage redeployment. Rememes deploys three functions from one artifact.
Live inventory confirms all affected media functions are Node 22/x86_64; API
is Node 22/ARM64. mediaResizerLoop exists only in production; no affected
staging-only unit was found.

The only static Sharp consumers are artwork asset processing, drop sanitizing,
mediaResizerLoop and the shared resize helper (s3Uploader/rememesLoop). NFT
preview loading is dynamic: only nftLinkMediaPreviewLoop renders previews.
API and other resolver callers enqueue jobs; they never call the codec loader.
The dependency diagnostic is imported only by the six media entry points.

## Validation and live smoke plan

- Preserve cross-platform optional dependencies and audit every affected lock.
- Run lint, full tests, root/API build and real-codec/multipart regressions.
- Build all six media ZIPs; extract, execute native codecs, inspect loaded ELF
  architecture, load the handler and run its bounded diagnostic in Lambda Node
  22/x64 without network access. Verify the API's Multer-containing bundle for
  its deployed ARM64 runtime.
- Wait for native Ubuntu, macOS Intel/ARM64 and Windows x64 CI and 6529bot.
- After each deployment, verify workflow artifact/commit/runtime/health evidence,
  retrieve the deployed ZIP and verify its native dependencies, then directly
  invoke exactly {"operator_action":"verify_media_dependencies_v1"} on every
  affected media function. This handles the three scheduled rememes functions
  without executing real queue, DB, upload or third-party work.
- Exercise staging multipart routes with synthetic fixtures and bounded safe
  validation paths; verify live mediaResizerLoop using isolated synthetic S3
  inputs during production and remove only the test keys created by this task.
- Keep production release-note grouping metadata identical across sequential
  runs; publish signal belongs only on the last successful service.

Coordinator release recording precedes staging merge; its outcome is reused
for production continuation. All fixes originate on the development branch.
