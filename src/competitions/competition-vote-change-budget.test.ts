import fc from 'fast-check';
import { CustomApiCompliantException } from '@/exceptions';
import {
  COMPETITION_VOTE_CHANGES_PER_MINUTE_DEFAULT,
  CompetitionVoteChangeBudget,
  competitionVoteChangesPerMinute
} from './competition-vote-change-budget';

function inMemoryCounter() {
  const counts = new Map<string, number>();
  const increment = jest.fn(async (key: string) => {
    const next = (counts.get(key) ?? 0) + 1;
    counts.set(key, next);
    return next;
  });
  return { increment, counts };
}

describe('competitionVoteChangesPerMinute', () => {
  it('defaults to 120 changes per minute', () => {
    expect(COMPETITION_VOTE_CHANGES_PER_MINUTE_DEFAULT).toBe(120);
    expect(competitionVoteChangesPerMinute({})).toBe(120);
  });

  it('reads whole numbers, with 0 turning the budget off', () => {
    expect(
      competitionVoteChangesPerMinute({
        COMPETITION_VOTE_CHANGES_PER_MINUTE: '30'
      })
    ).toBe(30);
    expect(
      competitionVoteChangesPerMinute({
        COMPETITION_VOTE_CHANGES_PER_MINUTE: '0'
      })
    ).toBe(0);
    expect(
      competitionVoteChangesPerMinute({
        COMPETITION_VOTE_CHANGES_PER_MINUTE: '1.5'
      })
    ).toBe(120);
    expect(
      competitionVoteChangesPerMinute({
        COMPETITION_VOTE_CHANGES_PER_MINUTE: '-4'
      })
    ).toBe(120);
  });
});

describe('CompetitionVoteChangeBudget', () => {
  it('admits the limit within a minute and rejects the next change with 429', async () => {
    const { increment } = inMemoryCounter();
    const budget = new CompetitionVoteChangeBudget(
      increment,
      () => 120_000 + 15_000,
      () => 3
    );

    for (let i = 0; i < 3; i++) {
      await expect(budget.spend('competition', 'voter')).resolves.toBe(
        undefined
      );
    }
    const rejection = await budget
      .spend('competition', 'voter')
      .catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(CustomApiCompliantException);
    const error = rejection as CustomApiCompliantException;
    expect(error.getStatusCode()).toBe(429);
    expect(error.code).toBe('VOTE_CHANGE_LIMIT');
    expect(error.message).toBe(
      'Too many vote changes in this decision: at most 3 per minute. Try again in 45 seconds.'
    );
    expect(error.details).toEqual({ retry_after_seconds: 45 });
  });

  it('counts each voter and competition separately, in minute windows', async () => {
    const { increment } = inMemoryCounter();
    let now = 0;
    const budget = new CompetitionVoteChangeBudget(
      increment,
      () => now,
      () => 1
    );

    await budget.spend('competition', 'voter');
    await budget.spend('competition', 'other-voter');
    await budget.spend('other-competition', 'voter');
    await expect(budget.spend('competition', 'voter')).rejects.toThrow(
      'Too many vote changes'
    );
    now = 60_000;
    await expect(budget.spend('competition', 'voter')).resolves.toBe(undefined);

    expect(increment.mock.calls.map(([key]) => key)).toEqual([
      'competition_vote_changes:{competition}:voter:0',
      'competition_vote_changes:{competition}:other-voter:0',
      'competition_vote_changes:{other-competition}:voter:0',
      'competition_vote_changes:{competition}:voter:0',
      'competition_vote_changes:{competition}:voter:1'
    ]);
    expect(increment).toHaveBeenCalledWith(expect.any(String), 61);
  });

  it('admits changes while Redis is unavailable', async () => {
    const budget = new CompetitionVoteChangeBudget(
      jest.fn().mockResolvedValue(null),
      () => 0,
      () => 1
    );

    await budget.spend('competition', 'voter');
    await expect(budget.spend('competition', 'voter')).resolves.toBe(undefined);
  });

  it('does nothing when turned off', async () => {
    const increment = jest.fn();
    const budget = new CompetitionVoteChangeBudget(
      increment,
      () => 0,
      () => 0
    );

    await budget.spend('competition', 'voter');

    expect(increment).not.toHaveBeenCalled();
  });

  it('never rejects a voter who stays within the limit in every minute', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 20 }),
        fc.array(fc.integer({ min: 0, max: 5 }), { maxLength: 30 }),
        async (limit, perMinute) => {
          const { increment } = inMemoryCounter();
          let now = 0;
          const budget = new CompetitionVoteChangeBudget(
            increment,
            () => now,
            () => limit
          );
          for (const changes of perMinute) {
            for (let i = 0; i < Math.min(changes, limit); i++) {
              await budget.spend('competition', 'voter');
            }
            now += 60_000;
          }
        }
      )
    );
  });
});
