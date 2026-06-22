import { RateMatter } from '@/entities/IRating';
import { RatingsDb } from './ratings.db';

function createExecutor() {
  return {
    execute: jest.fn().mockResolvedValue([]),
    executeNativeQueriesInTransaction: jest.fn(),
    getAffectedRows: jest.fn()
  };
}

describe('RatingsDb over-rate cleanup queries', () => {
  it('excludes help6529 Help6529 Credits rows from the over-rate tally', async () => {
    const executor = createExecutor();
    const repo = new RatingsDb(() => executor as never);

    await repo.getOverRateMatters();

    expect(executor.execute).toHaveBeenCalledWith(
      expect.stringContaining('help_bot_identity.normalised_handle'),
      expect.objectContaining({
        helpBotCreditCategory: 'Help6529 Credits',
        helpBotHandle: 'help6529'
      })
    );
  });

  it('excludes help6529 Help6529 Credits rows while selecting ratings to reduce', async () => {
    const executor = createExecutor();
    const repo = new RatingsDb(() => executor as never);

    await repo.getRatingsOnMatter(
      {
        rater_profile_id: 'help6529-profile',
        matter: RateMatter.REP
      },
      { connection: {} }
    );

    expect(executor.execute).toHaveBeenCalledWith(
      expect.stringContaining('help_bot_identity.normalised_handle'),
      expect.objectContaining({
        rater_profile_id: 'help6529-profile',
        matter: RateMatter.REP,
        helpBotCreditCategory: 'Help6529 Credits',
        helpBotHandle: 'help6529'
      }),
      expect.anything()
    );
  });
});
