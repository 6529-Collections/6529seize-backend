/**
 * The commit this bundle was built from: build.cjs passes it to esbuild as
 * a define. Unset when the code runs unbundled (tests, the CLI) or the build
 * couldn't tell (no git, or uncommitted changes).
 */
declare const __DB_DUMPS_DAILY_BUILD_COMMIT__: string | undefined;

/** The 40-hex commit of the build, or null when it is unknown. */
export function buildCommit(): string | null {
  const value =
    typeof __DB_DUMPS_DAILY_BUILD_COMMIT__ === 'string'
      ? __DB_DUMPS_DAILY_BUILD_COMMIT__
      : '';
  return /^[0-9a-f]{40}$/.test(value) ? value : null;
}
