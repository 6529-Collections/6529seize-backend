import { discoverClaimUpdates, decodeClaimUpdate } from './claim-events';
import { nftHistoryDb } from './history.db';
import { prepareHistoryWrite } from './processor';

export async function ingestClaimUpdates(
  from: number,
  to: number
): Promise<void> {
  for (const log of await discoverClaimUpdates(from, to)) {
    const event = await decodeClaimUpdate(log, (contract, id) =>
      nftHistoryDb.resolveClaim(contract, id)
    );
    const snapshot = await nftHistoryDb.snapshot(event.contract, event.nft_id);
    const plan = await prepareHistoryWrite(event, snapshot);
    if (plan.inserts.length) await nftHistoryDb.apply(plan);
  }
}
