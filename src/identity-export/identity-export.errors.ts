/**
 * Why an export at the freeze is refused, each with its exit code:
 * - `day` (3): not the freeze day's TDH yet: the TDH block, its time, the
 *   day's full TDH write or the identities sync;
 * - `over_credit` (4): raters over their credit, not acknowledged;
 * - `after_freeze` (5): REP or CIC changed after the freeze, not
 *   acknowledged.
 */
export type NotReadyCause = 'day' | 'over_credit' | 'after_freeze';

export const NOT_READY_EXIT_CODES: Readonly<Record<NotReadyCause, number>> = {
  day: 3,
  over_credit: 4,
  after_freeze: 5
};

export interface NotReadyProblem {
  readonly cause: NotReadyCause;
  readonly message: string;
}

/** The database is not at the freeze day, or not settled, for the export. */
export class IdentityExportNotReadyError extends Error {
  readonly causes: NotReadyCause[];

  constructor(problems: readonly NotReadyProblem[] | string) {
    const list: readonly NotReadyProblem[] =
      typeof problems === 'string'
        ? [{ cause: 'day', message: problems }]
        : problems;
    super(list.map((it) => it.message).join('; '));
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'IdentityExportNotReadyError';
    this.causes = list.map((it) => it.cause);
  }

  /** The exit code of the first cause in order: day, over credit, after. */
  get exitCode(): number {
    for (const cause of ['day', 'over_credit', 'after_freeze'] as const) {
      if (this.causes.includes(cause)) return NOT_READY_EXIT_CODES[cause];
    }
    return NOT_READY_EXIT_CODES.day;
  }
}
