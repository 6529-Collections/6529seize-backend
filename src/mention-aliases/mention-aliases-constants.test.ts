import {
  isReservedMentionAlias,
  normalizeMentionAlias
} from './mention-aliases.constants';

describe('mention alias constants', () => {
  it('normalizes aliases case-insensitively', () => {
    expect(normalizeMentionAlias('  @FrEnS ')).toBe('frens');
  });

  it.each([
    '@ALL',
    'Everyone',
    'ADMINS',
    'moderators',
    'contributors',
    'team',
    '6529DEVS',
    'DeVs6529'
  ])('reserves %s case-insensitively', (alias) => {
    expect(isReservedMentionAlias(alias)).toBe(true);
  });
});
