import {
  legacyWaveCreation,
  legacyWaveHubPatch,
  UpdateWaveHubSchema
} from './wave-hub.schemas';
import { ApiCreateNewWave } from '@/api/generated/models/ApiCreateNewWave';
import { ApiUpdateWaveRequest } from '@/api/generated/models/ApiUpdateWaveRequest';
import { getValidatedByJoiOrThrow } from '@/api/validation';

const legacy = {
  name: 'Wave',
  picture: null,
  description_drop: {
    parts: [{ content: 'Hello', media: [], quoted_drop: null }],
    referenced_nfts: [],
    mentioned_users: [],
    metadata: [],
    title: null,
    signature: null
  },
  visibility: { scope: { group_id: null } },
  chat: { enabled: true, scope: { group_id: null } },
  participation: { submission_strategy: { completely: 'invalid' } },
  voting: { credit_type: 'INVALID', period: { min: 'invalid' } },
  wave: {
    type: 'RANK',
    winning_threshold: 'invalid',
    decisions_strategy: { invalid: true },
    admin_group: { group_id: null }
  },
  outcomes: [{ invalid: true }]
};

describe('wave-only HTTP contracts', () => {
  it('accepts and ignores legacy competition settings before validation on creation', () => {
    const request = legacyWaveCreation(legacy as unknown as ApiCreateNewWave);
    expect(request.wave.type).toBe('CHAT');
    expect(request.wave.decisions_strategy).toBeNull();
    expect(request.wave.winning_threshold).toBeNull();
    expect(request.participation.submission_strategy).toBeNull();
    expect(request.outcomes).toEqual([]);
    expect(request.name).toBe('Wave');
  });
  it('strips competition fields from legacy edits without rejecting them', () => {
    expect(
      legacyWaveHubPatch(legacy as unknown as ApiUpdateWaveRequest)
    ).toEqual({
      name: 'Wave',
      picture: null,
      visibility: legacy.visibility,
      chat: legacy.chat,
      admin_group: { group_id: null }
    });
  });
  it('keeps omitted patch fields absent and explicit clearing values intact', () => {
    expect(
      getValidatedByJoiOrThrow(
        { picture: null, chat: { slow_mode_cooldown_ms: null } },
        UpdateWaveHubSchema
      )
    ).toEqual({ picture: null, chat: { slow_mode_cooldown_ms: null } });
  });
  it('ignores competition fields on v3 patches', () => {
    expect(
      getValidatedByJoiOrThrow(
        {
          name: 'New name',
          participation: null,
          voting: 123,
          outcomes: 'ignored',
          wave: { type: 'RANK' }
        },
        UpdateWaveHubSchema
      )
    ).toEqual({ name: 'New name' });
  });
  it('still rejects invalid shared settings', () => {
    expect(() =>
      getValidatedByJoiOrThrow(
        { chat: { slow_mode_cooldown_ms: 1 } },
        UpdateWaveHubSchema
      )
    ).toThrow();
    expect(() =>
      legacyWaveHubPatch(null as unknown as ApiUpdateWaveRequest)
    ).toThrow();
  });
});
