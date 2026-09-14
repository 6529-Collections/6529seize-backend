import { fetchNft } from '@/db-api';
import { MEMES_CONTRACT } from '@/constants';
import { getMaxMemeId } from '@/nftsLoop/db.nfts';

/** Last card closed to subscription changes, including an unreleased mint-day card. */
export async function getSubscriptionCutoffMemeId(): Promise<number> {
  const maxMemeId = await getMaxMemeId();
  const now = new Date();
  const day = now.getUTCDay();
  if (day !== 1 && day !== 3 && day !== 5) {
    return maxMemeId;
  }

  const latest = await fetchNft(MEMES_CONTRACT, maxMemeId);
  if (!latest?.mint_date) {
    return maxMemeId;
  }

  const latestMintDay = new Date(latest.mint_date).toISOString().slice(0, 10);
  return latestMintDay < now.toISOString().slice(0, 10)
    ? maxMemeId + 1
    : maxMemeId;
}
