import { loadEnv, unload } from '../secrets';
import * as votes from '../votes';
import { VoteMatterCategory } from '../entities/IVoteMatter';
import { VoteEvent } from '../entities/IVoteEvent';
import { Profile, ProfileArchived } from '../entities/IProfile';
import { Logger } from '../logging';

const logger = Logger.get('OVERVOTES_REVOCATION_LOOP');

export const handler = async () => {
  logger.info(`[RUNNING]`);
  await loadEnv([VoteMatterCategory, VoteEvent, Profile, ProfileArchived]);
  await votes.revokeOverVotes();
  await unload();
  logger.info(`[COMPLETE]`);
};
