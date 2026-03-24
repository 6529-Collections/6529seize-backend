import type { ProfileRetentionCandidate } from './identity';
import {
  selectProfileRetentionConsolidation,
  syncIdentityMetadataFromMergedProfiles
} from './identity';
import { anIdentity } from './tests/fixtures/identity.fixture';
import { profilesDb } from './profiles/profiles.db';
import { identitiesDb } from './identities/identities.db';
import { ProfileClassification } from './entities/IProfile';

afterEach(() => {
  jest.restoreAllMocks();
});

describe('selectProfileRetentionConsolidation', () => {
  function selectRetentionCandidate({
    candidates,
    delegatedPrimaryAddress = null,
    previousPrimaryAddress = null
  }: {
    candidates: ProfileRetentionCandidate[];
    delegatedPrimaryAddress?: string | null;
    previousPrimaryAddress?: string | null;
  }) {
    return selectProfileRetentionConsolidation({
      candidates,
      delegatedPrimaryAddress,
      previousPrimaryAddress
    });
  }

  it('prefers the delegated primary wallet when it survives in a resulting consolidation', () => {
    const selected = selectRetentionCandidate({
      candidates: [
        { consolidationKey: '0xaa-0xbb', tdh: 5 },
        { consolidationKey: '0xcc', tdh: 10 }
      ],
      delegatedPrimaryAddress: '0xbb',
      previousPrimaryAddress: '0xcc'
    });

    expect(selected).toBe('0xaa-0xbb');
  });

  it('falls back to the highest TDH consolidation when there is no delegated primary wallet', () => {
    const selected = selectRetentionCandidate({
      candidates: [
        { consolidationKey: '0xaa', tdh: 7 },
        { consolidationKey: '0xbb', tdh: 12 }
      ]
    });

    expect(selected).toBe('0xbb');
  });

  it('ignores a delegated primary wallet that does not survive in the resulting consolidations', () => {
    const selected = selectRetentionCandidate({
      candidates: [
        { consolidationKey: '0xaa', tdh: 9 },
        { consolidationKey: '0xbb', tdh: 4 }
      ],
      delegatedPrimaryAddress: '0xcc'
    });

    expect(selected).toBe('0xaa');
  });

  it('uses the previous stored primary address to break TDH ties', () => {
    const selected = selectRetentionCandidate({
      candidates: [
        { consolidationKey: '0xaa-0xbb', tdh: 8 },
        { consolidationKey: '0xcc', tdh: 8 }
      ],
      previousPrimaryAddress: '0xcc'
    });

    expect(selected).toBe('0xcc');
  });

  it('falls back to a deterministic lexicographic consolidation key when all other rules tie', () => {
    const selected = selectRetentionCandidate({
      candidates: [
        { consolidationKey: '0xbb', tdh: 8 },
        { consolidationKey: '0xaa', tdh: 8 }
      ]
    });

    expect(selected).toBe('0xaa');
  });
});

describe('syncIdentityMetadataFromMergedProfiles', () => {
  it('reapplies profile metadata after merge targets inherit an existing profile', async () => {
    const profile = {
      external_id: 'target-profile',
      handle: 'merged-handle',
      normalised_handle: 'merged-handle',
      primary_wallet: '0xdd',
      created_at: new Date(),
      created_by_wallet: '0xdd',
      banner_1: 'banner-1',
      banner_2: 'banner-2',
      pfp_url: 'pfp-url',
      classification: ProfileClassification.ORGANIZATION,
      sub_classification: 'sub-classification'
    };
    const getProfileByIdSpy = jest
      .spyOn(profilesDb, 'getProfileById')
      .mockResolvedValue(profile);
    const updateIdentityProfileSpy = jest
      .spyOn(identitiesDb, 'updateIdentityProfile')
      .mockResolvedValue();

    await syncIdentityMetadataFromMergedProfiles(
      [
        {
          sourceIdentities: [
            anIdentity(
              {},
              {
                consolidation_key: '0xdd',
                profile_id: 'source-profile',
                primary_address: '0xdd',
                handle: 'source-profile'
              }
            )
          ],
          targetIdentity: anIdentity(
            {},
            {
              consolidation_key: '0xaa-0xdd',
              profile_id: 'target-profile',
              primary_address: '0xaa',
              handle: 'target-profile'
            }
          ),
          originalIdentity: null
        }
      ],
      {} as any
    );

    expect(getProfileByIdSpy).toHaveBeenCalledWith('target-profile', {});
    expect(updateIdentityProfileSpy).toHaveBeenCalledWith(
      '0xaa-0xdd',
      {
        profile_id: 'target-profile',
        handle: 'merged-handle',
        classification: ProfileClassification.ORGANIZATION,
        normalised_handle: 'merged-handle',
        sub_classification: 'sub-classification',
        banner1: 'banner-1',
        banner2: 'banner-2',
        pfp: 'pfp-url'
      },
      {}
    );
  });

  it('skips merge targets that do not resolve to a profile row', async () => {
    jest.spyOn(profilesDb, 'getProfileById').mockResolvedValue(null);
    const updateIdentityProfileSpy = jest
      .spyOn(identitiesDb, 'updateIdentityProfile')
      .mockResolvedValue();

    await syncIdentityMetadataFromMergedProfiles(
      [
        {
          sourceIdentities: [
            anIdentity(
              {},
              {
                consolidation_key: '0xdd',
                profile_id: 'source-profile',
                primary_address: '0xdd',
                handle: 'source-profile'
              }
            )
          ],
          targetIdentity: anIdentity(
            {},
            {
              consolidation_key: '0xaa-0xdd',
              profile_id: 'target-profile',
              primary_address: '0xaa',
              handle: 'target-profile'
            }
          ),
          originalIdentity: null
        }
      ],
      {} as any
    );

    expect(updateIdentityProfileSpy).not.toHaveBeenCalled();
  });
});
