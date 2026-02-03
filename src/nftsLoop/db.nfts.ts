import { MEMES_CONTRACT, NFTS_TABLE } from '../constants';
import { DbQueryOptions } from '../db-query.options';
import { NFT } from '../entities/INFT';
import { sqlExecutor } from '../sql-executor';

export async function getMaxMemeId(
  completed?: boolean,
  options?: DbQueryOptions
): Promise<number> {
  let sql = `SELECT MAX(id) as max_id FROM ${NFTS_TABLE} WHERE contract = :contract`;
  if (completed) {
    sql += ` AND mint_date < CURDATE()`;
  }
  return (
    (await sqlExecutor.execute(sql, { contract: MEMES_CONTRACT }, options))[0]
      ?.max_id ?? 0
  );
}

export async function getNft(contract: string, id: number): Promise<NFT> {
  return (
    await sqlExecutor.execute(
      `SELECT * FROM ${NFTS_TABLE} WHERE contract = :contract AND id = :id
        LIMIT 1`,
      { contract, id }
    )
  )[0];
}
