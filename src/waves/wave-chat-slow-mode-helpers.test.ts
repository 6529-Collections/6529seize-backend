import { resolveNextDropAllowed } from './wave-chat-slow-mode.helpers';

describe('resolveNextDropAllowed', () => {
  const baseWave = {
    chat_enabled: true,
    chat_group_id: 'chat-group',
    chat_replies_open: false,
    created_by: 'creator',
    admin_group_id: null,
    chat_slow_mode_cooldown_ms: 60_000
  };

  it('reports the cooldown for chat group members', () => {
    expect(
      resolveNextDropAllowed({
        wave: baseWave,
        authenticatedProfileId: 'member',
        groupIdsUserIsEligibleFor: ['chat-group'],
        nextDropTimestamp: 2_000,
        now: 1_000
      })
    ).toBe(2_000);
  });

  it('reports the cooldown for open repliers outside the chat group', () => {
    expect(
      resolveNextDropAllowed({
        wave: { ...baseWave, chat_replies_open: true },
        authenticatedProfileId: 'replier',
        groupIdsUserIsEligibleFor: [],
        nextDropTimestamp: 2_000,
        now: 1_000
      })
    ).toBe(2_000);
  });

  it('ignores outsiders when replies are not open', () => {
    expect(
      resolveNextDropAllowed({
        wave: baseWave,
        authenticatedProfileId: 'outsider',
        groupIdsUserIsEligibleFor: [],
        nextDropTimestamp: 2_000,
        now: 1_000
      })
    ).toBeUndefined();
  });

  it('does not report an elapsed cooldown', () => {
    expect(
      resolveNextDropAllowed({
        wave: { ...baseWave, chat_replies_open: true },
        authenticatedProfileId: 'replier',
        groupIdsUserIsEligibleFor: [],
        nextDropTimestamp: 500,
        now: 1_000
      })
    ).toBeUndefined();
  });
});
