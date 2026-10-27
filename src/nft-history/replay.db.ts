import { EntityManager } from 'typeorm';
import { getDataSource } from '@/db';
import { NFTHistoryReplayJobEntity } from '@/entities/INFTHistoryReplayJob';
import { canonicalJson } from './canonical-json';
import { ReplayManifest } from './replay-manifest';
import { ReplayRange } from './replay-request';

export class NftHistoryReplayDb {
  find(jobId: string): Promise<NFTHistoryReplayJobEntity | null> {
    return getDataSource()
      .getRepository(NFTHistoryReplayJobEntity)
      .findOneBy({ job_id: jobId });
  }

  async create(
    jobId: string,
    digest: string,
    range: ReplayRange,
    manifest: ReplayManifest
  ): Promise<NFTHistoryReplayJobEntity> {
    const job = {
      job_id: jobId,
      digest,
      request_json: canonicalJson(range),
      manifest_json: canonicalJson(manifest),
      next_index: 0,
      created_at: new Date()
    };
    // No upsert: an existing job can never be silently replaced or rewound.
    await getDataSource().getRepository(NFTHistoryReplayJobEntity).insert(job);
    return job;
  }

  async advance(
    manager: EntityManager,
    jobId: string,
    expectedIndex: number
  ): Promise<void> {
    const repo = manager.getRepository(NFTHistoryReplayJobEntity);
    const job = await repo.findOne({
      where: { job_id: jobId },
      lock: { mode: 'pessimistic_write' }
    });
    if (job?.next_index !== expectedIndex)
      throw new Error('Replay cursor changed; reload the job');
    await repo.update({ job_id: jobId }, { next_index: expectedIndex + 1 });
  }
}

export const nftHistoryReplayDb = new NftHistoryReplayDb();
