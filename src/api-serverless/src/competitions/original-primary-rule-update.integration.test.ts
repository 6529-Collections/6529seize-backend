import { randomUUID } from 'node:crypto';
import { AuthenticationContext } from '@/auth-context';
import { ProfileProxyActionType } from '@/entities/IProfileProxyAction';
import { ApiCompetitionDraftInput } from '@/api/generated/models/ApiCompetitionDraftInput';
import { ApiCompetitionRulesInputTypeEnum } from '@/api/generated/models/ApiCompetitionRulesInput';
import { ApiWaveOutcomeType } from '@/api/generated/models/ApiWaveOutcomeType';
import { ApiWaveCreditType } from '@/api/generated/models/ApiWaveCreditType';
import { ApiWaveCreditScope } from '@/api/generated/models/ApiWaveCreditScope';
import { ApiWaveParticipationSubmissionStrategyType } from '@/api/generated/models/ApiWaveParticipationSubmissionStrategyType';
import { ApiWaveParticipationIdentitySubmissionAllowDuplicates } from '@/api/generated/models/ApiWaveParticipationIdentitySubmissionAllowDuplicates';
import { ApiWaveParticipationIdentitySubmissionWhoCanBeSubmitted } from '@/api/generated/models/ApiWaveParticipationIdentitySubmissionWhoCanBeSubmitted';
import {
  COMPETITION_DECISIONS_TABLE,
  COMPETITION_SCORE_HISTORY_TABLE,
  COMPETITION_VOTES_TABLE,
  COMPETITION_VOTE_HISTORY_TABLE
} from '@/constants';
import { Competition } from '@/competitions/competition.types';
import { competitionRepository } from '@/competitions/competition.repository';
import { NativeCompetitionReader } from '@/competitions/native-competition.reader';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { seedNativeOriginalPrimaryFixture } from '@/tests/fixtures/native-competition.fixture';
import { aWave } from '@/tests/fixtures/wave.fixture';
import { WaveType } from '@/entities/IWave';
import { loadNativeCommandConfiguration } from './competition-command-configuration';
import { validateOriginalPrimaryRuleUpdate } from './original-primary-rule-update';

const now = 2_000_000_000_000;
const progressed = now + 10_000;
const wave = aWave({
  type: WaveType.RANK,
  created_at: now - 4_000_000,
  next_decision_time: progressed,
  max_votes_per_identity_to_drop: 5,
  decisions_strategy: {
    first_decision_time: now - 3_590_000,
    subsequent_decisions: [3_600_000],
    is_rolling: true
  }
});

// Only native competition fixtures are inserted. No old wave, drop, voting,
// outcome, or decision rows supply this policy's history or current state.
describeWithSeed('Original primary native rule update policy', [], () => {
  let competition: Competition;
  let previous: ApiCompetitionDraftInput;

  beforeEach(async () => {
    jest.spyOn(Date, 'now').mockReturnValue(now);
    const seeded = await seedNativeOriginalPrimaryFixture(wave);
    const record = (await competitionRepository.findCompetitionRecordById(
      seeded.id,
      {}
    ))!;
    competition = await new NativeCompetitionReader(
      competitionRepository,
      {}
    ).getCompetition(record, now);
    previous = await loadNativeCommandConfiguration(record, {});
  });
  afterEach(() => jest.restoreAllMocks());

  const nextConfig = () =>
    JSON.parse(JSON.stringify(previous)) as ApiCompetitionDraftInput;
  const validate = (
    next: ApiCompetitionDraftInput,
    state = competition,
    authenticationContext?: AuthenticationContext
  ) =>
    sqlExecutor.executeNativeQueriesInTransaction(async (connection) => {
      await competitionRepository.lockOriginalPrimary(wave.id, { connection });
      return validateOriginalPrimaryRuleUpdate(previous, next, state, {
        connection,
        authenticationContext
      });
    });

  async function seedVote(
    source: 'current' | 'mutation' | 'transferred' | 'aggregate'
  ) {
    const params = {
      id: competition.id,
      entryId: randomUUID(),
      voteId: randomUUID(),
      now
    };
    if (source === 'current')
      await sqlExecutor.execute(
        `insert into ${COMPETITION_VOTES_TABLE} (id,competition_id,entry_id,voter_profile_id,value,credit_spent,created_at,updated_at) values (:voteId,:id,:entryId,'voter',7,7,:now,:now)`,
        params
      );
    else if (source === 'mutation')
      await sqlExecutor.execute(
        `insert into ${COMPETITION_VOTE_HISTORY_TABLE} (competition_id,entry_id,voter_profile_id,value,previous_value,aggregate_value,credit_delta,occurred_at) values (:id,:entryId,'voter',0,7,0,-7,:now)`,
        params
      );
    else
      await sqlExecutor.execute(
        `insert into ${COMPETITION_SCORE_HISTORY_TABLE} (competition_id,kind,sequence,entry_id,drop_id,voter_profile_id,value,occurred_at) values (:id,:kind,1,:entryId,'historical-drop','voter',7,:now)`,
        { ...params, kind: source === 'aggregate' ? 'AGGREGATE' : 'VOTER' }
      );
  }

  it('keeps a progressed decision when old admin controls change other editable rules after voting', async () => {
    await seedVote('transferred');
    const next = nextConfig();
    next.title = 'Updated title';
    next.description = 'Native description';
    next.participation.scope.group_id = 'new-participants';
    next.participation.no_of_applications_allowed_per_participant = 12;
    next.participation.terms = 'Updated terms';
    next.voting.scope.group_id = 'new-voters';
    next.voting.period = { min: now - 5_000, max: now + 50_000 };
    next.rules.time_lock_ms = 600_000;
    next.rules.max_votes_per_identity_to_drop = 6;
    await expect(validate(next)).resolves.toEqual({
      scheduleChanged: false,
      nextDecisionTime: progressed
    });
  });

  it('keeps threshold and hold controls editable after voting', async () => {
    await seedVote('transferred');
    previous.rules.type = ApiCompetitionRulesInputTypeEnum.Approve;
    previous.rules.decisions_strategy = null;
    const next = nextConfig();
    next.rules.winning_threshold = 14;
    next.rules.winning_threshold_min_duration_ms = 60_000;
    await expect(validate(next)).resolves.toMatchObject({
      scheduleChanged: false
    });
  });

  it('rejects original settings from proxies even with wave administration rights', async () => {
    const proxy = new AuthenticationContext({
      authenticatedWallet: null,
      authenticatedProfileId: 'delegate',
      roleProfileId: 'owner',
      activeProxyActions: [
        {
          id: 'proxy-action',
          type: ProfileProxyActionType.CREATE_WAVE,
          credit_amount: null,
          credit_spent: null
        }
      ]
    });
    await expect(validate(nextConfig(), competition, proxy)).rejects.toThrow(
      'Legacy competition settings cannot be changed by proxies'
    );
  });

  it('keeps original type immutable before the first entry or vote', async () => {
    const next = nextConfig();
    next.rules.type = ApiCompetitionRulesInputTypeEnum.Approve;
    await expect(validate(next)).rejects.toThrow(
      'Original competition type cannot change'
    );
  });

  it('keeps identity nomination strategy immutable before the first entry or vote', async () => {
    const next = nextConfig();
    next.participation.submission_strategy = {
      type: ApiWaveParticipationSubmissionStrategyType.Identity,
      config: {
        who_can_be_submitted:
          ApiWaveParticipationIdentitySubmissionWhoCanBeSubmitted.Everyone,
        duplicates:
          ApiWaveParticipationIdentitySubmissionAllowDuplicates.AlwaysAllow
      }
    };
    await expect(validate(next)).rejects.toThrow(
      'identity submission strategy cannot be changed'
    );
    previous.participation.submission_strategy = JSON.parse(
      JSON.stringify(next.participation.submission_strategy)
    );
    next.participation.submission_strategy.config.duplicates =
      ApiWaveParticipationIdentitySubmissionAllowDuplicates.NeverAllow;
    await expect(validate(next)).rejects.toThrow(
      'identity submission strategy cannot be changed'
    );
  });

  it.each([
    { limit: 6, allowed: true },
    { limit: null, allowed: true },
    { limit: 4, allowed: false }
  ])(
    'allows vote limit $limit only when it increases or removes the cap',
    async ({ limit, allowed }) => {
      const next = nextConfig();
      next.rules.max_votes_per_identity_to_drop = limit;
      if (allowed)
        await expect(validate(next)).resolves.toMatchObject({
          scheduleChanged: false
        });
      else
        await expect(validate(next)).rejects.toThrow('can only be increased');
    }
  );

  it('does not replace an unlimited vote cap with a finite cap', async () => {
    previous.rules.max_votes_per_identity_to_drop = null;
    const next = nextConfig();
    next.rules.max_votes_per_identity_to_drop = 10;
    await expect(validate(next)).rejects.toThrow('can only be increased');
  });

  it('accepts a newly future decision strategy and starts at that strategy', async () => {
    const next = nextConfig();
    next.rules.decisions_strategy = {
      first_decision_time: now + 50_000,
      subsequent_decisions: [],
      is_rolling: false
    };
    await expect(validate(next)).resolves.toEqual({
      scheduleChanged: true,
      nextDecisionTime: now + 50_000
    });
  });

  it('rejects a changed strategy whose first decision is already past', async () => {
    const next = nextConfig();
    next.rules.decisions_strategy = {
      first_decision_time: now - 1,
      subsequent_decisions: [],
      is_rolling: false
    };
    await expect(validate(next)).rejects.toThrow(
      'first_decision_time must be in the future'
    );
  });

  it('rejects an edit while a decision remains unresolved', async () => {
    await expect(
      validate(nextConfig(), {
        ...competition,
        decisions: { ...competition.decisions, next_decision_time: now - 1 }
      })
    ).rejects.toThrow('unresolved decisions');
  });

  it('counts only this competition completed decisions when checking max winners', async () => {
    previous.rules.type = ApiCompetitionRulesInputTypeEnum.Approve;
    for (const [index, status] of Array.from(
      ['COMPLETED', 'COMPLETED', 'SKIPPED'].entries()
    ))
      await sqlExecutor.execute(
        `insert into ${COMPETITION_DECISIONS_TABLE} (id,competition_id,scheduled_at,decided_at,status,execution_key,created_at) values (:decisionId,:id,:at,:at,:status,:key,:at)`,
        {
          id: competition.id,
          decisionId: randomUUID(),
          at: now - 1000 - index,
          status,
          key: randomUUID()
        }
      );
    await sqlExecutor.execute(
      `insert into ${COMPETITION_DECISIONS_TABLE} (id,competition_id,scheduled_at,decided_at,status,execution_key,created_at) values (:decisionId,:id,:at,:at,'COMPLETED',:key,:at)`,
      {
        id: randomUUID(),
        decisionId: randomUUID(),
        at: now - 2000,
        key: randomUUID()
      }
    );
    const next = nextConfig();
    next.rules.max_winners = 1;
    await expect(validate(next)).rejects.toThrow("max_winners can't be lower");
    next.rules.max_winners = 2;
    await expect(validate(next)).resolves.toMatchObject({
      scheduleChanged: false
    });
    next.rules.max_winners = null;
    await expect(validate(next)).resolves.toMatchObject({
      scheduleChanged: false
    });
  });

  it.each(['current', 'mutation', 'transferred'] as const)(
    'locks credit rules when only %s voter evidence exists',
    async (source) => {
      await seedVote(source);
      const next = nextConfig();
      next.voting.credit_type = ApiWaveCreditType.Xtdh;
      await expect(validate(next)).rejects.toThrow(
        'Voting credit rules are immutable after the first vote'
      );
    }
  );

  const creditChanges: [string, (next: ApiCompetitionDraftInput) => void][] = [
    [
      'type',
      (next) => {
        next.voting.credit_type = ApiWaveCreditType.Xtdh;
      }
    ],
    [
      'scope',
      (next) => {
        next.voting.credit_scope = ApiWaveCreditScope.Drop;
      }
    ],
    [
      'category',
      (next) => {
        next.voting.credit_category = 'New category';
      }
    ],
    [
      'creditor',
      (next) => {
        next.voting.creditor_id = 'new-creditor';
      }
    ],
    [
      'NFTs',
      (next) => {
        next.voting.credit_nfts = [
          {
            contract: '0x0000000000000000000000000000000000000001',
            token_id: 1
          }
        ];
      }
    ],
    [
      'negative votes',
      (next) => {
        next.voting.forbid_negative_votes = true;
      }
    ]
  ];
  it.each(creditChanges)(
    'locks the %s credit rule after a historical vote',
    async (_name, change) => {
      await seedVote('transferred');
      const next = nextConfig();
      change(next);
      await expect(validate(next)).rejects.toThrow(
        'Voting credit rules are immutable after the first vote'
      );
    }
  );

  it('permits credit changes before any voter history even when aggregate history exists', async () => {
    await seedVote('aggregate');
    const next = nextConfig();
    next.voting.credit_type = ApiWaveCreditType.Xtdh;
    await expect(validate(next)).resolves.toMatchObject({
      scheduleChanged: false
    });
  });

  it('keeps original outcome definitions immutable before voting', async () => {
    const next = nextConfig();
    next.outcomes = [
      {
        type: ApiWaveOutcomeType.Manual,
        description: 'Changed award',
        distribution: []
      }
    ];
    await expect(validate(next)).rejects.toThrow(
      'outcome definitions are immutable'
    );
  });
});
