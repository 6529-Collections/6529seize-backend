import { MEMES_CONTRACT, NFTS_TABLE } from '@/constants';
import { NFT } from '@/entities/INFT';
import { sqlExecutor } from '@/sql-executor';

export async function getMaxMemeId(completed?: boolean): Promise<number> {
  return (await getNewestMeme(completed))?.id || 0;
}

export async function getNewestMeme(completed?: boolean): Promise<NFT | null> {
  const sql = `SELECT * FROM ${NFTS_TABLE} WHERE contract = :contract ${completed ? 'AND mint_date < CURDATE()' : ''} ORDER BY id DESC LIMIT 1`;
  return await sqlExecutor.oneOrNull<NFT>(sql, {
    contract: MEMES_CONTRACT
  });
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
