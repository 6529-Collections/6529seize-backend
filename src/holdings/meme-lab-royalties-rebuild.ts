import { MEME_LAB_ROYALTIES_TABLE } from '@/constants';
import { sqlExecutor } from '@/sql-executor';
// Each Meme Lab card's royalty splits, token id -> splits, as 6529.io holds
// them. They were typed in by hand and nothing on Ethereum records them, so
// this reviewed file is their source for a rebuild.
import MEME_LAB_ROYALTIES from './meme-lab-royalties.json';

export interface MemeLabRoyaltySplits {
  readonly primary_royalty_split: number;
  readonly secondary_royalty_split: number;
}

/** The splits in the file, checked: whole token ids, splits from 0 to 1. */
export function readMemeLabRoyalties(
  file: Record<string, MemeLabRoyaltySplits> = MEME_LAB_ROYALTIES as Record<
    string,
    MemeLabRoyaltySplits
  >
): { token_id: number; primary: number; secondary: number }[] {
  return Object.entries(file)
    .map(([tokenId, splits]) => {
      const token_id = Number(tokenId);
      const primary = Number(splits.primary_royalty_split);
      const secondary = Number(splits.secondary_royalty_split);
      if (
        !Number.isInteger(token_id) ||
        token_id < 0 ||
        ![primary, secondary].every((split) => split >= 0 && split <= 1)
      ) {
        throw new Error(`Invalid Meme Lab royalty splits for token ${tokenId}`);
      }
      return { token_id, primary, secondary };
    })
    .sort((a, b) => a.token_id - b.token_id);
}

/** Rebuilds meme_lab_royalties from the repository file. */
export async function rebuildMemeLabRoyalties(): Promise<void> {
  const rows = readMemeLabRoyalties();
  await sqlExecutor.executeNativeQueriesInTransaction(async (connection) => {
    await sqlExecutor.execute(
      `DELETE FROM ${MEME_LAB_ROYALTIES_TABLE}`,
      undefined,
      {
        wrappedConnection: connection
      }
    );
    for (const row of rows) {
      await sqlExecutor.execute(
        `INSERT INTO ${MEME_LAB_ROYALTIES_TABLE}
           (token_id, primary_royalty_split, secondary_royalty_split)
         VALUES (:token_id, :primary, :secondary)`,
        row,
        { wrappedConnection: connection }
      );
    }
  });
}
