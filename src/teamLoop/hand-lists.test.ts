import { readFileSync } from 'fs';
import {
  HandListFileError,
  parsePrevoteArtists,
  PREVOTE_ARTISTS_FILE
} from './hand-lists';

describe('the pre-vote artists file', () => {
  it('reads card numbers and profile ids', () => {
    expect(
      parsePrevoteArtists(
        'artists.csv',
        'card_no,profile_id\r\n10,profile-1\n10,profile-2\n11,profile-1\n\n'
      )
    ).toEqual([
      { card_no: 10, profile_id: 'profile-1' },
      { card_no: 10, profile_id: 'profile-2' },
      { card_no: 11, profile_id: 'profile-1' }
    ]);
  });

  it.each([
    ['a file with no rows', 'card_no,profile_id\n', 'no rows'],
    ['another header', 'card,profile\n1,p\n', 'first line'],
    ['a missing value', 'card_no,profile_id\n1\n', 'line 2'],
    [
      'a card that is not a number',
      'card_no,profile_id\nx,p\n',
      'not a number'
    ],
    ['the same badge twice', 'card_no,profile_id\n1,p\n1,p\n', 'twice']
  ])('refuses %s', (_name, text, message) => {
    expect(() => parsePrevoteArtists('artists.csv', text)).toThrow(
      HandListFileError
    );
    expect(() => parsePrevoteArtists('artists.csv', text)).toThrow(message);
  });

  it('ships with its header only, until the team fills it in', () => {
    const text = readFileSync(`${__dirname}/${PREVOTE_ARTISTS_FILE}`, 'utf8');
    expect(() => parsePrevoteArtists(PREVOTE_ARTISTS_FILE, text)).toThrow(
      'no rows'
    );
  });
});
