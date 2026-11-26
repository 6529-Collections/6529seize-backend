import { Rememe, RememeSource } from '@/entities/IRememe';
import { equalIgnoreCase } from '@/strings';

export interface RememeFileRow {
  readonly contract: string;
  readonly id: string;
}

/**
 * The rememes a run of the file loop removes: those no longer in rememes.csv.
 * With `keepAdded`, only rows that came from the file are candidates, so
 * rememes people added through the site stay; without it every row missing
 * from the file goes, as the loop has always done.
 */
export function rememesMissingFromFile(
  rememes: readonly Rememe[],
  fileRows: readonly RememeFileRow[],
  keepAdded: boolean
): Rememe[] {
  return rememes.filter(
    (rememe) =>
      (!keepAdded || rememe.source === RememeSource.FILE) &&
      !fileRows.some(
        (row) =>
          equalIgnoreCase(rememe.contract, row.contract) && rememe.id == row.id
      )
  );
}
