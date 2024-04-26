import { loadEnv, unload } from '../secrets';
import { Logger } from '../logging';
import * as sentryContext from '../sentry.context';
import { Profile } from '../entities/IProfile';
import { sqlExecutor } from '../sql-executor';
import { PROFILES_TABLE } from '../constants';
import { profilesService } from '../profiles/profiles.service';
import { ProfileAndConsolidations } from '../profiles/profile.types';
import {
  getDelegationPrimaryAddressForConsolidation,
  getHighestTdhAddressForConsolidationKey
} from '../delegationsLoop/db.delegations';
import { areEqualAddresses } from '../helpers';
import { Wallet } from '../entities/IWallet';

const logger = Logger.get('CUSTOM_REPLAY_LOOP');

export const handler = sentryContext.wrapLambdaHandler(async () => {
  logger.info(`[RUNNING]`);
  await loadEnv([Profile]);
  await replay();
  await unload();
  logger.info('[COMPLETE]');
});

async function replay() {
  // logger.info(`[CUSTOM REPLAY NOT IMPLEMENTED]`);
  const profiles = await sqlExecutor.execute(`SELECT * FROM ${PROFILES_TABLE}`);

  const profilesWithConsolidationKey: ProfileAndConsolidations[] = [];
  await Promise.all(
    profiles.map(async (profile: Profile) => {
      const p = await profilesService.getProfileByWallet(
        profile.primary_wallet
      );
      if (p) {
        profilesWithConsolidationKey.push(p);
      }
    })
  );
  logger.info(`[PROFILES: ${profiles.length}]`);
  logger.info(
    `[PROFILES WITH CONSOLIDATIONS: ${profilesWithConsolidationKey.length}]`
  );

  const profilesToUpdate = await getPrimaryAddressUpdates(
    profilesWithConsolidationKey
  );
  logger.info(`[PROFILES TO BE UPDATED: ${profilesToUpdate.length}]`);

  // for (const profile of profilesToUpdate) {
  //   await profilesService.updateProfilePrimaryAddress(
  //     profile.external_id,
  //     profile.primary_wallet
  //   );
  // }
}

async function getPrimaryAddressUpdates(profiles: ProfileAndConsolidations[]) {
  const profilesToUpdate: Profile[] = [];

  for (const profile of profiles) {
    if (profile?.profile && profile.consolidation.consolidation_key) {
      const primaryAddress = await determinePrimaryAddress(
        profile.consolidation.wallets,
        profile.consolidation.consolidation_key
      );

      const currentPrimaryAddress = profile.profile.primary_wallet;
      if (!areEqualAddresses(primaryAddress, currentPrimaryAddress)) {
        logger.info(
          `[PROFILE ${profile.profile.external_id}] : [HANDLE ${profile.profile.handle}] : [DETECTED PRIMARY ADDRESS CHANGE] : [${currentPrimaryAddress} -> ${primaryAddress}]`
        );
        const changedProfile = profile.profile;
        changedProfile.primary_wallet = primaryAddress;
        profilesToUpdate.push(changedProfile);
      }
    }
  }

  return profilesToUpdate;
}

async function determinePrimaryAddress(
  wallets: { wallet: Wallet }[],
  consolidationKey: string
): Promise<string> {
  if (wallets.length === 1) {
    return wallets[0].wallet.address;
  }

  const delegationPrimaryAddress =
    await getDelegationPrimaryAddressForConsolidation(consolidationKey);
  if (delegationPrimaryAddress) {
    return delegationPrimaryAddress;
  }

  const highestTdhAddress = await getHighestTdhAddressForConsolidationKey(
    consolidationKey
  );
  if (highestTdhAddress) {
    return highestTdhAddress;
  }

  return wallets[0].wallet.address;
}
