import { NFTS_TABLE, MEMES_CONTRACT } from '../constants';
import { NFT } from '../entities/INFT';
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

export async function getNft(contract: string, id: number): Promise<NFT> {
  return (
    await sqlExecutor.execute(
      `SELECT * FROM ${NFTS_TABLE} WHERE contract = :contract AND id = :id
        LIMIT 1`,
      { contract, id }
    )
  )[0];
}
