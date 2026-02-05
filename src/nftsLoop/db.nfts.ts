import { MEMES_CONTRACT, NFTS_TABLE } from '@/constants';
import { DbQueryOptions } from '@/db-query.options';
import { NFT } from '@/entities/INFT';
import { sqlExecutor } from '@/sql-executor';

export async function getMaxMemeId(
  completed?: boolean,
  options?: DbQueryOptions
): Promise<number> {
  return (await getNewestMeme(completed, options))?.id ?? 0;
}

export async function getNewestMeme(
  completed?: boolean,
  options?: DbQueryOptions
): Promise<NFT | null> {
  const sql = `SELECT * FROM ${NFTS_TABLE} WHERE contract = :contract ${completed ? 'AND mint_date < CURDATE()' : ''} ORDER BY id DESC LIMIT 1`;
  return sqlExecutor.oneOrNull<NFT>(sql, { contract: MEMES_CONTRACT }, options);
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
