import { canonicalJson, historyDigest } from './canonical-json';
import { EntityManager } from 'typeorm';
import { getDataSource } from '@/db';
import { NFTHistory, NFTHistoryClaim } from '@/entities/INFTHistory';
import {
  HistoryEdit,
  NFTHistoryEventEntity
} from '@/entities/INFTHistoryEvent';

export interface HistorySnapshot {
  legacy: NFTHistory[];
  events: NFTHistoryEventEntity[];
}

export interface HistoryWritePlan {
  contract: string;
  nft_id: number;
  before: string;
  previous_uri?: string;
  inserts: NFTHistoryEventEntity[];
  eventUpdates: { event_id: string; description: HistoryEdit | null }[];
  legacyUpdates: {
    uri: string;
    transaction_hash: string;
    description: HistoryEdit;
  }[];
}

export function historyFingerprint(snapshot: HistorySnapshot): string {
  // A fixed projection also makes ORM property order and created_at precision irrelevant.
  const rows = [
    ...snapshot.legacy.map((row) => [
      'legacy',
      row.contract.toLowerCase(),
      row.nft_id,
      row.uri,
      row.block,
      row.transaction_hash.toLowerCase(),
      row.description
    ]),
    ...snapshot.events.map((row) => [
      'event',
      row.event_id,
      row.contract.toLowerCase(),
      row.nft_id,
      row.uri,
      row.block,
      row.block_hash,
      row.transaction_hash.toLowerCase(),
      row.transaction_index,
      row.log_index,
      row.description
    ])
  ]
    .map((row) => canonicalJson(row))
    .sort((a, b) => a.localeCompare(b));
  return historyDigest(rows);
}

export class NftHistoryDb {
  async resolveClaim(contract: string, claimId: string): Promise<number[]> {
    const rows = await getDataSource()
      .getRepository(NFTHistoryClaim)
      .createQueryBuilder('claim')
      .where(
        'claim.contract = :contract AND claim.claimIndex = :claimId AND claim.nft_id >= 0',
        { contract, claimId }
      )
      .getMany();
    return rows.map((row) => Number(row.nft_id));
  }

  async snapshot(
    contract: string,
    nft_id: number,
    manager = getDataSource().manager,
    lock = false
  ): Promise<HistorySnapshot> {
    const options = {
      where: { contract, nft_id },
      ...(lock ? { lock: { mode: 'pessimistic_write' as const } } : {})
    };
    // Both reads must use the same transaction manager when checking a plan.
    const legacy = await manager.getRepository(NFTHistory).find(options);
    const events = await manager
      .getRepository(NFTHistoryEventEntity)
      .find(options);
    return { legacy, events };
  }

  async apply(
    plan: HistoryWritePlan,
    afterWrite?: (manager: EntityManager) => Promise<void>
  ): Promise<void> {
    await getDataSource().transaction(async (manager) => {
      const current = await this.snapshot(
        plan.contract,
        plan.nft_id,
        manager,
        true
      );
      if (historyFingerprint(current) !== plan.before)
        throw new Error(
          'History changed since plan preparation; regenerate the plan'
        );
      for (const { description, ...row } of plan.inserts) {
        await manager
          .getRepository(NFTHistoryEventEntity)
          .createQueryBuilder()
          .insert()
          .values({ ...row, description: () => ':historyDescription' })
          .setParameter(
            'historyDescription',
            description === null ? null : JSON.stringify(description)
          )
          .execute();
      }
      for (const update of plan.eventUpdates) {
        await manager
          .getRepository(NFTHistoryEventEntity)
          .save({ event_id: update.event_id, description: update.description });
      }
      for (const update of plan.legacyUpdates) {
        await manager.getRepository(NFTHistory).save({
          contract: plan.contract,
          nft_id: plan.nft_id,
          uri: update.uri,
          description: update.description
        });
      }
      await afterWrite?.(manager);
    });
  }
}

export const nftHistoryDb = new NftHistoryDb();
