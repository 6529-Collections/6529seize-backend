import { MEMES_CONTRACT } from '@/constants';
import {
  getNextgenNetwork,
  NEXTGEN_CORE_CONTRACT
} from '@/nextgen/nextgen_constants';
import { waveVotingCreditNftKey } from '@/waves/wave-voting-credit-nfts';
import { ApiCreateNewWave } from '../generated/models/ApiCreateNewWave';
import { ApiWaveCreditType } from '../generated/models/ApiWaveCreditType';
import { ApiWaveType } from '../generated/models/ApiWaveType';
import { WaveApiService } from './wave.api.service';

function createRequest({
  creditType = ApiWaveCreditType.CardSetTdh,
  contract = MEMES_CONTRACT.toLowerCase(),
  tokenId = 1,
  creditNfts,
  waveType = ApiWaveType.Rank
}: {
  creditType?: ApiWaveCreditType;
  contract?: string;
  tokenId?: number;
  creditNfts?: { contract: string; token_id: number }[] | null;
  waveType?: ApiWaveType;
} = {}): ApiCreateNewWave {
  return {
    name: 'Wave 1',
    picture: null,
    description_drop: {
      title: null,
      signature: null,
      parts: [
        {
          content: 'gm',
          quoted_drop: null,
          media: []
        }
      ],
      referenced_nfts: [],
      mentioned_users: [],
      metadata: []
    },
    voting: {
      scope: { group_id: null },
      credit_type: creditType,
      credit_scope: undefined,
      credit_category: null,
      credit_nfts:
        creditType === ApiWaveCreditType.CardSetTdh
          ? (creditNfts ?? [
              {
                contract,
                token_id: tokenId
              }
            ])
          : null,
      creditor_id: null,
      signature_required: false,
      period: {
        min: null,
        max: null
      },
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
      period: {
        min: null,
        max: null
      },
      terms: null,
      submission_strategy: null
    },
    chat: {
      scope: { group_id: null },
      enabled: true
    },
    wave: {
      type: waveType,
      winning_threshold: null,
      max_winners: null,
      max_votes_per_identity_to_drop: null,
      time_lock_ms: null,
      admin_group: { group_id: null },
      decisions_strategy: null,
      admin_drop_deletion_enabled: false
    },
    outcomes: []
  };
}

describe('WaveApiService card-set TDH validation', () => {
  function createService() {
    const wavesApiDb = {
      findExistingCardSetCreditNftKeys: jest
        .fn()
        .mockResolvedValue(
          new Set([waveVotingCreditNftKey(MEMES_CONTRACT.toLowerCase(), 1)])
        )
    };
    const userGroupsService = {
      getByIds: jest.fn().mockResolvedValue([])
    };
    const service = new WaveApiService(
      wavesApiDb as any,
      userGroupsService as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any
    );
    return { service, wavesApiDb, userGroupsService };
  }

  it('rejects CARD_SET_TDH on chat waves', async () => {
    const { service } = createService();

    await expect(
      (service as any).validateWaveRelations(
        createRequest({ waveType: ApiWaveType.Chat }),
        { timer: undefined }
      )
    ).rejects.toThrow(`Only APPROVE and RANK waves support CARD_SET_TDH`);
  });

  it('rejects NextGen contracts for CARD_SET_TDH', async () => {
    const { service } = createService();

    await expect(
      (service as any).validateWaveRelations(
        createRequest({
          contract: NEXTGEN_CORE_CONTRACT[getNextgenNetwork()].toLowerCase()
        }),
        { timer: undefined }
      )
    ).rejects.toThrow(
      `Only MEMES and GRADIENTS currently support CARD_SET_TDH`
    );
  });

  it('rejects unsupported contracts for CARD_SET_TDH', async () => {
    const { service } = createService();

    await expect(
      (service as any).validateWaveRelations(
        createRequest({
          contract: '0x0000000000000000000000000000000000000001'
        }),
        { timer: undefined }
      )
    ).rejects.toThrow(
      `Only MEMES and GRADIENTS currently support CARD_SET_TDH`
    );
  });

  it('rejects unknown NFTs for CARD_SET_TDH', async () => {
    const { service, wavesApiDb } = createService();
    (
      wavesApiDb.findExistingCardSetCreditNftKeys as jest.Mock
    ).mockResolvedValue(new Set());

    await expect(
      (service as any).validateWaveRelations(createRequest(), {
        timer: undefined
      })
    ).rejects.toThrow(`NFT ${MEMES_CONTRACT.toLowerCase()}/1 not found`);
  });

  it('accepts indexed CARD_SET_TDH config', async () => {
    const { service, wavesApiDb } = createService();

    await expect(
      (service as any).validateWaveRelations(createRequest(), {
        timer: undefined
      })
    ).resolves.toBeUndefined();

    expect(wavesApiDb.findExistingCardSetCreditNftKeys).toHaveBeenCalledWith(
      [
        {
          contract: MEMES_CONTRACT.toLowerCase(),
          tokenId: 1
        }
      ],
      { timer: undefined }
    );
  });
});
