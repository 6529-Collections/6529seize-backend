import type { DataSource } from 'typeorm';
import { getDataSource } from '@/db';
import { ARTISTS_TABLE, MEME_LAB_ROYALTIES_TABLE } from '@/constants';

/**
 * Tables whose entities schema sync leaves alone (ArtistEntity and
 * MemeLabRoyaltyEntity): production's tables predate the entities and their
 * exact column types are not known here, so sync must never plan an ALTER on
 * them. A fresh schema (tests, the rebuild check) still needs them, so they
 * are created when missing, as the entities describe them, and never changed.
 */
const CREATE_IF_MISSING: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS \`${ARTISTS_TABLE}\` (
     \`name\` varchar(255) NOT NULL,
     \`created_at\` datetime NULL,
     \`memes\` text NULL,
     \`memelab\` text NULL,
     \`gradients\` text NULL,
     \`bio\` text NULL,
     \`pfp\` text NULL,
     \`work\` text NULL,
     \`social_links\` text NULL,
     PRIMARY KEY (\`name\`)
   ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS \`${MEME_LAB_ROYALTIES_TABLE}\` (
     \`token_id\` int NOT NULL,
     \`primary_royalty_split\` double NOT NULL DEFAULT 0,
     \`secondary_royalty_split\` double NOT NULL DEFAULT 0,
     PRIMARY KEY (\`token_id\`)
   ) ENGINE=InnoDB`
];

/** Creates the unsynced holdings tables that are missing; changes none that exist. */
export async function createMissingUnsyncedHoldingsTables(
  source: DataSource = getDataSource()
): Promise<void> {
  const runner = source.createQueryRunner('master');
  try {
    for (const statement of CREATE_IF_MISSING) {
      await runner.query(statement);
    }
  } finally {
    await runner.release();
  }
}
