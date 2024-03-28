import { NFTS_TABLE, MEMES_CONTRACT } from '../constants';
import { sqlExecutor } from '../sql-executor';

export async function getMaxMemeId() {
  return (
    (
      await sqlExecutor.execute(
        `SELECT MAX(id) as max_id FROM ${NFTS_TABLE} WHERE contract = :contract`,
        { contract: MEMES_CONTRACT }
      )
    )[0]?.max_id ?? 0
  );
}
