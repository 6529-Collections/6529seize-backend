import {
  buildDropVotePushBody,
  buildDropVotePushTitle,
  formatSignedLocaleNumber,
  getRatingChangeEmoji,
  truncateDropLabel
} from '@/pushNotificationsHandler/drop-vote-push-notification-text';

describe('drop vote push notification text', () => {
  it('formats initial votes with locale separators', () => {
    expect(
      buildDropVotePushTitle({
        voterHandle: 'prxt0',
        vote: 1201,
        voteChange: 1201
      })
    ).toBe('🚀 prxt0 rated your drop');
  });

  it('formats vote edits by change and includes ratings in the body', () => {
    expect(
      buildDropVotePushTitle({
        voterHandle: 'prxt0',
        vote: 171,
        voteChange: -1030
      })
    ).toBe('💔 prxt0 updated their rating on your drop');
    expect(
      buildDropVotePushBody({
        dropBody: 'Intern test',
        vote: 171,
        voteChange: -1030,
        totalVote: 12345
      })
    ).toBe(
      'Drop: Intern test\nChange: -1,030\nNew rating: +171\nTotal Drop Rating: +12,345'
    );
  });

  it('formats vote removals as negative updates with zero new rating', () => {
    expect(
      buildDropVotePushTitle({
        voterHandle: 'prxt0',
        vote: 0,
        voteChange: -5
      })
    ).toBe('💔 prxt0 updated their rating on your drop');
    expect(
      buildDropVotePushBody({
        dropBody: 'Intern test',
        vote: 0,
        voteChange: -5,
        totalVote: 12340
      })
    ).toBe(
      'Drop: Intern test\nChange: -5\nNew rating: 0\nTotal Drop Rating: +12,340'
    );
  });

  it('omits the drop line when there is no real drop content', () => {
    expect(
      buildDropVotePushBody({
        dropBody: '',
        vote: 5,
        voteChange: 5,
        totalVote: 12345
      })
    ).toBe('Change: +5\nNew rating: +5\nTotal Drop Rating: +12,345');
  });

  it('formats negative values with the sign before locale separators', () => {
    expect(formatSignedLocaleNumber(-1201)).toBe('-1,201');
  });

  it('formats zero without a sign', () => {
    expect(formatSignedLocaleNumber(0)).toBe('0');
  });

  it('chooses rating change emojis by sign', () => {
    expect(getRatingChangeEmoji(1)).toBe('🚀 ');
    expect(getRatingChangeEmoji(-1)).toBe('💔 ');
    expect(getRatingChangeEmoji(0)).toBe('');
  });

  it('truncates long drop labels to a single short line', () => {
    expect(truncateDropLabel(`${'a'.repeat(90)}\nsecond line`)).toBe(
      `${'a'.repeat(77)}...`
    );
  });
});
