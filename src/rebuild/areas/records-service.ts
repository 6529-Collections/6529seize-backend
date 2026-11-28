import { profileIdByWallet } from '@/rebuild/run/probe-fixture.steps';

/**
 * The records service of a rebuild run is the world's records-service
 * actor, which the identity seed writes (from the chain, or as plain rows
 * without an identity import): read by its wallet, it must be the profile
 * the records flags name. No seed writes its identity, keys or profile;
 * the seeds that need it (publish's, mint's) call this first.
 */
export async function assertRecordsServiceActor(
  profileId: string,
  wallet: string
): Promise<void> {
  const holder = await profileIdByWallet(wallet);
  if (holder !== profileId) {
    throw new Error(
      `The records service's wallet ${wallet} belongs to profile ${holder}; the records flags name ${profileId}`
    );
  }
}
