import { DEVS_6529_MENTION_TOKEN } from '@/constants/mentions';
import { HELP_BOT_HANDLE } from '@/help-bot/help-bot.config';
import { isHandleReservedFor, RESERVED_HANDLES } from './profiles.constants';

describe('isHandleReservedFor', () => {
  it('reserves the validator route for new and renamed profiles, ignoring case', () => {
    expect(isHandleReservedFor('validator', null)).toBe(true);
    expect(isHandleReservedFor('Validator', 'someone')).toBe(true);
    expect(isHandleReservedFor('VALIDATOR', undefined)).toBe(true);
  });

  const botAndMentionTokens = [
    HELP_BOT_HANDLE,
    DEVS_6529_MENTION_TOKEN,
    'admins',
    'contributors',
    'all'
  ];

  it.each(botAndMentionTokens)('reserves %s', (handle) => {
    expect(RESERVED_HANDLES).toContain(handle);
    expect(isHandleReservedFor(handle, null)).toBe(true);
    expect(isHandleReservedFor(handle.toUpperCase(), 'someone')).toBe(true);
  });

  it.each(botAndMentionTokens)(
    'lets the profile that already holds %s keep it',
    (handle) => {
      expect(isHandleReservedFor(handle, handle)).toBe(false);
      expect(isHandleReservedFor(handle, handle.toUpperCase())).toBe(false);
    }
  );

  it('does not reserve ordinary handles', () => {
    expect(isHandleReservedFor('punk6529', null)).toBe(false);
    expect(isHandleReservedFor('help6530', 'help6529')).toBe(false);
  });
});
