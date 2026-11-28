/** Ends a child of the rebuild run with its error on stderr and exit code 1. */
export function exitWithError(label: string, error: unknown): never {
  const detail =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${label} ${detail}\n`);
  process.exit(1);
}
