import { EntityManager } from 'typeorm';
import { getDataSource } from '@/db';
import { NFTHistory, NFTHistoryClaim } from '@/entities/INFTHistory';
import { NFTS_HISTORY_CLAIMS_TABLE } from '@/constants';
import { nftHistoryDb, historyFingerprint } from './history.db';
import {
  HistorySourcePlan,
  SourceReader,
  StoredSourceClaim,
  claimFingerprint
} from './source-plan';

export class HistorySourceDb implements SourceReader {
  history(contract: string, tokenId: number) {
    return nftHistoryDb.snapshot(contract, tokenId);
  }

  claims(
    contract: string,
    claimId: string,
    manager = getDataSource().manager,
    lock = false
  ): Promise<StoredSourceClaim[]> {
    const query = manager
      .getRepository(NFTHistoryClaim)
      .createQueryBuilder('claim')
      .where('claim.contract = :contract AND claim.claimIndex = :claimId', {
        contract,
        claimId
      });
    if (lock) query.setLock('pessimistic_write');
    return query.getMany();
  }

  async apply(
    plan: HistorySourcePlan,
    afterWrite?: (manager: EntityManager) => Promise<void>
  ): Promise<void> {
    await getDataSource().transaction(async (manager) => {
      for (const mapping of plan.claims) {
        const record = mapping.record;
        const current = await this.claims(
          record.contract,
          record.claimId,
          manager,
          true
        );
        if (claimFingerprint(current) !== mapping.before)
          throw new Error(
            'Claim mapping changed since audit; review a fresh plan'
          );
        await manager.query(
          `INSERT INTO ${NFTS_HISTORY_CLAIMS_TABLE} (contract, claimIndex, location, nft_id) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE nft_id=VALUES(nft_id)`,
          [record.contract, record.claimId, record.location, record.tokenId]
        );
      }
      for (const write of plan.writes) {
        if (write.kind === 'edit') {
          await nftHistoryDb.applyInTransaction(write.plan, manager);
        } else {
          const current = await nftHistoryDb.snapshot(
            write.row.contract,
            write.row.nft_id,
            manager,
            true
          );
          if (historyFingerprint(current) !== write.before)
            throw new Error(
              'Mint history changed since audit; review a fresh plan'
            );
          const { description, ...row } = write.row;
          await manager
            .getRepository(NFTHistory)
            .createQueryBuilder()
            .insert()
            .values({ ...row, description: () => ':mintDescription' })
            .setParameter('mintDescription', JSON.stringify(description))
            .execute();
        }
      }
      await afterWrite?.(manager);
    });
  }
}

export const historySourceDb = new HistorySourceDb();
