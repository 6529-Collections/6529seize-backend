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

/**
 * The drops stage stopped before its last wave because its caller asked it
 * to (a job with a time limit, through stopBeforeWave). The waves it had
 * started were finished first, so every file it wrote is whole; a later run
 * with resumeDrops reads the waves left. export.json is not written.
 */
export class WavesExportStoppedError extends Error {
  /** Waves whose drops were left for a later run. */
  readonly wavesLeft: number;
  /** Waves the stage had to read. */
  readonly waves: number;

  constructor(wavesLeft: number, waves: number) {
    super(
      `The drops stage stopped with ${wavesLeft} of ${waves} waves left for a later run`
    );
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'WavesExportStoppedError';
    this.wavesLeft = wavesLeft;
    this.waves = waves;
  }
}
