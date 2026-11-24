/**
 * A command line, a time or a state the export refuses: the CLI prints the
 * message (and the help when the command line was wrong) and exits 2.
 */
export class WavesExportUsageError extends Error {
  /** Whether the command line was wrong, so the help is worth printing. */
  readonly showHelp: boolean;

  constructor(message: string, options: { showHelp?: boolean } = {}) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'WavesExportUsageError';
    this.showHelp = options.showHelp ?? true;
  }
}
