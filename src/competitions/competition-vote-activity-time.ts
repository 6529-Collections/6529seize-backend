interface ActivityTime {
  readonly occurred_at: number | string | null;
  readonly legacy_id?: string | null;
  readonly legacy_created_at?: Date | string | null;
}

function sharedTime(
  timestamp: Date | string | null | undefined
): number | null {
  if (timestamp == null) return null;
  return timestamp instanceof Date
    ? timestamp.getTime()
    : new Date(timestamp).getTime();
}

/** Preserve the shared log reader's driver-decoded DATETIME, including its timezone. */
export function pageCompetitionVoteActivity<T extends ActivityTime>(
  candidates: T[],
  offset: number,
  limit: number
): T[] {
  return (
    candidates
      .map((row) =>
        row.legacy_id == null
          ? row
          : {
              ...row,
              occurred_at: sharedTime(row.legacy_created_at)
            }
      )
      // SQL supplies the permanent source/sequence/ID tie order. Stable sorting
      // merges the two bounded source pages after their actual wire times decode.
      .sort((left, right) => {
        if (left.occurred_at === null)
          return right.occurred_at === null ? 0 : 1;
        if (right.occurred_at === null) return -1;
        return Number(right.occurred_at) - Number(left.occurred_at);
      })
      .slice(offset, offset + limit)
  );
}
