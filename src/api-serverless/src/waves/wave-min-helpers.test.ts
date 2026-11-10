import {
  mapWaveToApiWaveMin,
  WaveMinSource
} from '@/api/waves/wave-min.helpers';

describe('mapWaveToApiWaveMin', () => {
  function wave(overrides: Partial<WaveMinSource> = {}): WaveMinSource {
    return {
      id: 'wave-1',
      name: 'Wave 1',
      picture: null,
      description_drop_id: 'description-drop',
      created_by: 'creator',
      last_drop_time: 0,
      submission_type: null,
      chat_enabled: true,
      chat_group_id: null,
      chat_replies_open: false,
      voting_group_id: null,
      participation_group_id: null,
      admin_group_id: null,
      voting_credit_type: 'TDH',
      voting_credit_scope: 'WAVE',
      voting_credit_nfts: null,
      voting_period_start: null,
      voting_period_end: null,
      visibility_group_id: null,
      admin_drop_deletion_enabled: false,
      forbid_negative_votes: false,
      ...overrides
    };
  }

  it('sets authenticated_user_admin when the authenticated user created the wave', () => {
    const mapped = mapWaveToApiWaveMin({
      wave: wave(),
      displayByWaveId: {},
      groupIdsUserIsEligibleFor: [],
      noRightToVote: false,
      noRightToParticipate: false,
      pinned: false,
      identityWave: false,
      authenticatedProfileId: 'creator'
    });

    expect(mapped.authenticated_user_admin).toBe(true);
  });

  it('lets outsiders reply only when the wave opens replies', () => {
    const map = (chatRepliesOpen: boolean) =>
      mapWaveToApiWaveMin({
        wave: wave({
          chat_group_id: 'dev-team',
          chat_replies_open: chatRepliesOpen
        }),
        displayByWaveId: {},
        groupIdsUserIsEligibleFor: [],
        noRightToVote: false,
        noRightToParticipate: false,
        pinned: false,
        identityWave: false,
        authenticatedProfileId: 'viewer'
      });

    expect(map(true)).toMatchObject({
      authenticated_user_eligible_to_chat: false,
      authenticated_user_eligible_to_reply: true,
      authenticated_user_can_delete_replies: false
    });
    expect(map(false)).toMatchObject({
      authenticated_user_eligible_to_chat: false,
      authenticated_user_eligible_to_reply: false
    });
  });

  it('maps card-set TDH config into ApiWaveMin', () => {
    const mapped = mapWaveToApiWaveMin({
      wave: wave({
        voting_credit_type: 'CARD_SET_TDH',
        voting_credit_nfts: [
          {
            contract: '0x33fd426905f149f8376e227d0c9d3340aad17af1',
            tokenId: 1
          },
          {
            contract: '0x33fd426905f149f8376e227d0c9d3340aad17af1',
            tokenId: 2
          }
        ]
      }),
      displayByWaveId: {},
      groupIdsUserIsEligibleFor: [],
      noRightToVote: false,
      noRightToParticipate: false,
      pinned: false,
      identityWave: false,
      authenticatedProfileId: 'creator'
    });

    expect(mapped.voting_credit_nfts).toEqual([
      {
        contract: '0x33fd426905f149f8376e227d0c9d3340aad17af1',
        token_id: 1
      },
      {
        contract: '0x33fd426905f149f8376e227d0c9d3340aad17af1',
        token_id: 2
      }
    ]);
    expect(mapped.voting_credit_scope).toBe('WAVE');
  });
});

import { getWaveMinPermissionMask } from '@/api/waves/wave-min.helpers';
import { AuthenticationContext } from '@/auth-context';
import { ProfileProxyActionType } from '@/entities/IProfileProxyAction';

describe('getWaveMinPermissionMask with a wave-scoped proxy grant', () => {
  function proxyContext(waveAllowlist: readonly string[] | null) {
    return new AuthenticationContext({
      authenticatedWallet: '0xgrantee',
      authenticatedProfileId: 'grantee',
      roleProfileId: 'grantor',
      activeProxyActions: [
        {
          id: 'post',
          type: ProfileProxyActionType.CREATE_DROP_TO_WAVE,
          credit_amount: null,
          credit_spent: null,
          wave_allowlist: waveAllowlist
        }
      ]
    });
  }

  function participationFlag(noRightToParticipate: boolean): boolean {
    return mapWaveToApiWaveMin({
      wave: {
        id: 'wave-2',
        name: 'Wave 2',
        picture: null,
        description_drop_id: 'd',
        created_by: 'creator',
        last_drop_time: 0,
        submission_type: null,
        chat_enabled: true,
        chat_group_id: null,
        chat_replies_open: false,
        voting_group_id: null,
        participation_group_id: null,
        admin_group_id: null,
        voting_credit_type: 'TDH',
        voting_credit_scope: 'WAVE',
        voting_credit_nfts: null,
        voting_period_start: null,
        voting_period_end: null,
        visibility_group_id: null,
        admin_drop_deletion_enabled: false,
        forbid_negative_votes: false
      },
      displayByWaveId: {},
      groupIdsUserIsEligibleFor: [],
      noRightToVote: false,
      noRightToParticipate,
      pinned: false,
      identityWave: false,
      authenticatedProfileId: 'grantee'
    }).authenticated_user_eligible_to_participate;
  }

  it('keeps the wave-independent flag and adds a per-wave one', () => {
    const mask = getWaveMinPermissionMask(proxyContext(['wave-1']));
    expect(mask.noRightToParticipate).toBe(false);
    expect(mask.noRightToParticipateIn('wave-1')).toBe(false);
    expect(mask.noRightToParticipateIn('wave-2')).toBe(true);
    expect(participationFlag(mask.noRightToParticipateIn('wave-2'))).toBe(
      false
    );
    expect(participationFlag(mask.noRightToParticipateIn('wave-1'))).toBe(true);
  });

  it('is unrestricted for a legacy grant and for a non-proxy user', () => {
    expect(
      getWaveMinPermissionMask(proxyContext(null)).noRightToParticipateIn(
        'wave-2'
      )
    ).toBe(false);
    expect(
      getWaveMinPermissionMask(
        AuthenticationContext.fromProfileId('me')
      ).noRightToParticipateIn('wave-2')
    ).toBe(false);
  });

  it('denies everything without a context', () => {
    const mask = getWaveMinPermissionMask(undefined);
    expect(mask.noRightToParticipate).toBe(true);
    expect(mask.noRightToParticipateIn('wave-1')).toBe(true);
  });
});
