import { MEMES_CONTRACT } from '@/constants';
import { aWave } from '@/tests/fixtures/wave.fixture';
import { WavesMappers } from '@/api/waves/waves.mappers';
import { WaveCreditScope, WaveCreditType, WaveType } from '@/entities/IWave';
import { ApiWaveCreditScope } from '../generated/models/ApiWaveCreditScope';
import { ApiWaveCreditType } from '../generated/models/ApiWaveCreditType';
import { ApiWaveType } from '../generated/models/ApiWaveType';
import { ApiUpdateWaveRequest } from '../generated/models/ApiUpdateWaveRequest';

describe('WavesMappers', () => {
  it('maps approve decision counts and closed-state eligibility', () => {
    const mapper = new WavesMappers({} as any, {} as any, {} as any, {} as any);
    const waveEntity = {
      ...aWave(
        {
          type: WaveType.APPROVE,
          winning_min_threshold: 10,
          winning_threshold_min_duration_ms: 60_000,
          max_winners: 2,
          max_votes_per_identity_to_drop: 3
        },
        {
          id: 'wave-1',
          name: 'Wave 1',
          serial_no: 1
        }
      ),
      participation_required_metadata: [],
      participation_required_media: []
    };

    const mapped = (mapper as any).mapWaveEntityToApiWave({
      waveEntity,
      relatedData: {
        contributors: {},
        profiles: {
          [waveEntity.created_by]: { id: waveEntity.created_by } as any
        },
        curations: {},
        displayByWaveId: {},
        creationDrops: {
          [waveEntity.description_drop_id]: {
            id: waveEntity.description_drop_id
          }
        },
        subscribedActions: {},
        metrics: {
          'wave-1': {
            wave_id: 'wave-1',
            drops_count: 0,
            subscribers_count: 0,
            participatory_drops_count: 0,
            latest_drop_timestamp: 0
          }
        },
        authenticatedUserMetrics: {},
        authenticatedUserReaderMetrics: {},
        chatDropCooldowns: {},
        yourParticipationDropsCountByWaveId: {},
        yourUnreadDropsCountByWaveId: {},
        firstUnreadDropSerialNoByWaveId: {},
        wavePauses: {},
        decisionsDoneByWaveId: { 'wave-1': 2 },
        votingCreditNftsByWaveId: {},
        pinnedWaveIds: new Set<string>(),
        identityWaveIds: new Set<string>(),
        authenticatedUserId: waveEntity.created_by
      },
      noRightToVote: false,
      groupIdsUserIsEligibleFor: [],
      noRightToParticipate: false
    });

    expect(mapped.wave.winning_threshold).toBe(10);
    expect(mapped.wave.winning_threshold_min_duration_ms).toBe(60_000);
    expect(mapped.wave.max_votes_per_identity_to_drop).toBe(3);
    expect(mapped.wave.total_no_of_decisions).toBe(2);
    expect(mapped.wave.no_of_decisions_done).toBe(2);
    expect(mapped.wave.no_of_decisions_left).toBe(0);
    expect(mapped.voting.authenticated_user_eligible).toBe(false);
    expect(mapped.participation.authenticated_user_eligible).toBe(false);
    expect(mapped.chat.authenticated_user_eligible).toBe(true);
    expect(mapped.chat.links_disabled).toBe(false);
    expect(mapped.chat).not.toHaveProperty('next_drop_allowed');
    expect(mapped.chat).not.toHaveProperty('slow_mode_cooldown_ms');
  });

  it('maps active chat slow mode cooldown into ApiWave chat context', () => {
    const mapper = new WavesMappers({} as any, {} as any, {} as any, {} as any);
    const nextDropTimestamp = Date.now() + 60000;
    const waveEntity = {
      ...aWave(
        {
          chat_slow_mode_cooldown_ms: 60000
        },
        {
          id: 'wave-1',
          name: 'Wave 1',
          serial_no: 1
        }
      ),
      participation_required_metadata: [],
      participation_required_media: []
    };

    const mapped = (mapper as any).mapWaveEntityToApiWave({
      waveEntity,
      relatedData: {
        contributors: {},
        profiles: {
          [waveEntity.created_by]: { id: waveEntity.created_by } as any
        },
        curations: {},
        displayByWaveId: {},
        creationDrops: {
          [waveEntity.description_drop_id]: {
            id: waveEntity.description_drop_id
          }
        },
        subscribedActions: {},
        metrics: {
          'wave-1': {
            wave_id: 'wave-1',
            drops_count: 0,
            subscribers_count: 0,
            participatory_drops_count: 0,
            latest_drop_timestamp: 0
          }
        },
        authenticatedUserMetrics: {},
        authenticatedUserReaderMetrics: {},
        chatDropCooldowns: {
          'wave-1': {
            wave_id: 'wave-1',
            profile_id: 'viewer-1',
            next_drop_timestamp: nextDropTimestamp,
            created_at: 1,
            updated_at: 1
          }
        },
        yourParticipationDropsCountByWaveId: {},
        yourUnreadDropsCountByWaveId: {},
        firstUnreadDropSerialNoByWaveId: {},
        wavePauses: {},
        decisionsDoneByWaveId: {},
        votingCreditNftsByWaveId: {},
        pinnedWaveIds: new Set<string>(),
        identityWaveIds: new Set<string>(),
        authenticatedUserId: 'viewer-1'
      },
      noRightToVote: false,
      groupIdsUserIsEligibleFor: [],
      noRightToParticipate: false
    });

    expect(mapped.chat.authenticated_user_eligible).toBe(false);
    expect(mapped.chat.next_drop_allowed).toBe(nextDropTimestamp);
    expect(mapped.chat.slow_mode_cooldown_ms).toBe(60000);
  });

  it('preserves max_votes_per_identity_to_drop on update when omitted', async () => {
    const mapper = new WavesMappers({} as any, {} as any, {} as any, {} as any);
    const request: ApiUpdateWaveRequest = {
      name: 'Wave 1',
      picture: null,
      voting: {
        scope: { group_id: null },
        credit_type: ApiWaveCreditType.Tdh,
        credit_category: null,
        credit_nfts: null,
        creditor_id: null,
        signature_required: false,
        period: undefined,
        forbid_negative_votes: false
      },
      visibility: {
        scope: { group_id: null }
      },
      participation: {
        scope: { group_id: null },
        no_of_applications_allowed_per_participant: null,
        required_metadata: [],
        required_media: [],
        signature_required: false,
        period: undefined,
        terms: null,
        submission_strategy: null
      },
      chat: {
        scope: { group_id: null },
        enabled: true
      },
      wave: {
        type: ApiWaveType.Rank,
        winning_threshold: null,
        max_winners: null,
        time_lock_ms: null,
        admin_group: { group_id: null },
        decisions_strategy: null,
        admin_drop_deletion_enabled: false
      }
    };

    const mapped = await mapper.createWaveToNewWaveEntity({
      id: 'wave-1',
      serial_no: 1,
      created_at: 1,
      updated_at: 2,
      request,
      created_by: 'profile-1',
      descriptionDropId: 'drop-1',
      nextDecisionTime: null,
      isDirectMessage: false,
      existingWaveSettings: {
        max_votes_per_identity_to_drop: 7,
        chat_links_disabled: true,
        voting_credit_scope: WaveCreditScope.DROP,
        parent_wave_id: null
      }
    });

    expect(mapped.max_votes_per_identity_to_drop).toBe(7);
    expect(mapped.voting_credit_scope).toBe(WaveCreditScope.DROP);
    expect(mapped.chat_slow_mode_cooldown_ms).toBeNull();
    expect(mapped.chat_links_disabled).toBe(true);
  });

  it('maps chat slow mode config into entity fields', async () => {
    const mapper = new WavesMappers({} as any, {} as any, {} as any, {} as any);
    const request: ApiUpdateWaveRequest = {
      name: 'Wave 1',
      picture: null,
      voting: {
        scope: { group_id: null },
        credit_type: ApiWaveCreditType.Tdh,
        credit_category: null,
        credit_nfts: null,
        creditor_id: null,
        signature_required: false,
        period: undefined,
        forbid_negative_votes: false
      },
      visibility: {
        scope: { group_id: null }
      },
      participation: {
        scope: { group_id: null },
        no_of_applications_allowed_per_participant: null,
        required_metadata: [],
        required_media: [],
        signature_required: false,
        period: undefined,
        terms: null,
        submission_strategy: null
      },
      chat: {
        scope: { group_id: null },
        enabled: true,
        slow_mode_cooldown_ms: 45000,
        links_disabled: true
      },
      wave: {
        type: ApiWaveType.Chat,
        winning_threshold: null,
        max_winners: null,
        time_lock_ms: null,
        admin_group: { group_id: null },
        decisions_strategy: null,
        admin_drop_deletion_enabled: false
      }
    };

    const mapped = await mapper.createWaveToNewWaveEntity({
      id: 'wave-1',
      serial_no: 1,
      created_at: 1,
      updated_at: 2,
      request,
      created_by: 'profile-1',
      descriptionDropId: 'drop-1',
      nextDecisionTime: null,
      isDirectMessage: false
    });

    expect(mapped.chat_slow_mode_cooldown_ms).toBe(45000);
    expect(mapped.chat_links_disabled).toBe(true);
  });

  it('maps card-set TDH config into entity fields and API output', async () => {
    const mapper = new WavesMappers({} as any, {} as any, {} as any, {} as any);
    const request: ApiUpdateWaveRequest = {
      name: 'Wave 1',
      picture: null,
      voting: {
        scope: { group_id: null },
        credit_type: ApiWaveCreditType.CardSetTdh,
        credit_scope: ApiWaveCreditScope.Drop,
        credit_category: null,
        credit_nfts: [
          {
            contract: MEMES_CONTRACT.toLowerCase(),
            token_id: 1
          },
          {
            contract: MEMES_CONTRACT.toLowerCase(),
            token_id: 2
          }
        ],
        creditor_id: null,
        signature_required: false,
        period: undefined,
        forbid_negative_votes: false
      },
      visibility: {
        scope: { group_id: null }
      },
      participation: {
        scope: { group_id: null },
        no_of_applications_allowed_per_participant: null,
        required_metadata: [],
        required_media: [],
        signature_required: false,
        period: undefined,
        terms: null,
        submission_strategy: null
      },
      chat: {
        scope: { group_id: null },
        enabled: true
      },
      wave: {
        type: ApiWaveType.Rank,
        winning_threshold: null,
        max_winners: null,
        time_lock_ms: null,
        admin_group: { group_id: null },
        decisions_strategy: null,
        admin_drop_deletion_enabled: false
      }
    };

    const entity = await mapper.createWaveToNewWaveEntity({
      id: 'wave-1',
      serial_no: 1,
      created_at: 1,
      updated_at: 2,
      request,
      created_by: 'profile-1',
      descriptionDropId: 'drop-1',
      nextDecisionTime: null,
      isDirectMessage: false
    });

    expect(entity.voting_credit_nfts).toEqual([
      {
        contract: MEMES_CONTRACT.toLowerCase(),
        tokenId: 1
      },
      {
        contract: MEMES_CONTRACT.toLowerCase(),
        tokenId: 2
      }
    ]);
    expect(entity.voting_credit_scope).toBe(WaveCreditScope.DROP);

    const waveEntity = {
      ...aWave(
        {
          type: WaveType.RANK,
          voting_credit_type: WaveCreditType.CARD_SET_TDH
        },
        {
          id: 'wave-1',
          name: 'Wave 1',
          serial_no: 1
        }
      ),
      participation_required_metadata: [],
      participation_required_media: []
    };

    const mapped = (mapper as any).mapWaveEntityToApiWave({
      waveEntity,
      relatedData: {
        contributors: {},
        profiles: {
          [waveEntity.created_by]: { id: waveEntity.created_by } as any
        },
        curations: {},
        displayByWaveId: {},
        creationDrops: {
          [waveEntity.description_drop_id]: {
            id: waveEntity.description_drop_id
          }
        },
        subscribedActions: {},
        metrics: {
          'wave-1': {
            wave_id: 'wave-1',
            drops_count: 0,
            subscribers_count: 0,
            participatory_drops_count: 0,
            latest_drop_timestamp: 0
          }
        },
        authenticatedUserMetrics: {},
        authenticatedUserReaderMetrics: {},
        chatDropCooldowns: {},
        yourParticipationDropsCountByWaveId: {},
        yourUnreadDropsCountByWaveId: {},
        firstUnreadDropSerialNoByWaveId: {},
        wavePauses: {},
        decisionsDoneByWaveId: {},
        votingCreditNftsByWaveId: {
          'wave-1': [
            {
              contract: MEMES_CONTRACT.toLowerCase(),
              tokenId: 1
            },
            {
              contract: MEMES_CONTRACT.toLowerCase(),
              tokenId: 2
            }
          ]
        },
        pinnedWaveIds: new Set<string>(),
        identityWaveIds: new Set<string>(),
        authenticatedUserId: waveEntity.created_by
      },
      noRightToVote: false,
      groupIdsUserIsEligibleFor: [],
      noRightToParticipate: false
    });

    expect(mapped.voting.credit_nfts).toEqual([
      {
        contract: MEMES_CONTRACT.toLowerCase(),
        token_id: 1
      },
      {
        contract: MEMES_CONTRACT.toLowerCase(),
        token_id: 2
      }
    ]);
    expect(mapped.voting.credit_scope).toBe(ApiWaveCreditScope.Wave);
  });
});
