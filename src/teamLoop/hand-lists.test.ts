import { readFileSync } from 'fs';
import {
  HandListFileError,
  MEME_LAB_SPLITS_FILE,
  parseMemeLabSplits,
  parsePrevoteArtists,
  PREVOTE_ARTISTS_FILE
} from './hand-lists';

describe('hand list files', () => {
  it('reads Meme Lab splits', () => {
    expect(
      parseMemeLabSplits(
        'splits.csv',
        'token_id,primary_royalty_split,secondary_royalty_split\r\n1,0.5,0.25\n2,1,0\n\n'
      )
    ).toEqual([
      {
        token_id: 1,
        primary_royalty_split: 0.5,
        secondary_royalty_split: 0.25
      },
      { token_id: 2, primary_royalty_split: 1, secondary_royalty_split: 0 }
    ]);
  });

  it('reads pre-vote artists', () => {
    expect(
      parsePrevoteArtists(
        'artists.csv',
        'card_no,profile_id\n10,profile-1\n10,profile-2\n11,profile-1\n'
      )
    ).toEqual([
      { card_no: 10, profile_id: 'profile-1' },
      { card_no: 10, profile_id: 'profile-2' },
      { card_no: 11, profile_id: 'profile-1' }
    ]);
  });

  it.each([
    [
      'a file with no rows',
      'token_id,primary_royalty_split,secondary_royalty_split\n',
      'no rows'
    ],
    ['another header', 'id,primary,secondary\n1,0,0\n', 'first line'],
    [
      'a missing value',
      'token_id,primary_royalty_split,secondary_royalty_split\n1,0.5\n',
      'line 2'
    ],
    [
      'a split above 1',
      'token_id,primary_royalty_split,secondary_royalty_split\n1,50,0\n',
      'from 0 to 1'
    ],
    [
      'a negative split',
      'token_id,primary_royalty_split,secondary_royalty_split\n1,-0.5,0\n',
      'from 0 to 1'
    ],
    [
      'a token twice',
      'token_id,primary_royalty_split,secondary_royalty_split\n1,0,0\n1,0.5,0\n',
      'twice'
    ],
    [
      'a token that is not a number',
      'token_id,primary_royalty_split,secondary_royalty_split\nx,0,0\n',
      'not a number'
    ]
  ])('refuses %s', (_name, text, message) => {
    expect(() => parseMemeLabSplits('splits.csv', text)).toThrow(
      HandListFileError
    );
    expect(() => parseMemeLabSplits('splits.csv', text)).toThrow(message);
  });

  it('refuses the same badge twice', () => {
    expect(() =>
      parsePrevoteArtists('artists.csv', 'card_no,profile_id\n1,p\n1,p\n')
    ).toThrow('twice');
  });

  it('ships the files with their header only, until the team fills them in', () => {
    for (const [name, parse] of [
      [MEME_LAB_SPLITS_FILE, parseMemeLabSplits],
      [PREVOTE_ARTISTS_FILE, parsePrevoteArtists]
    ] as const) {
      const text = readFileSync(`${__dirname}/${name}`, 'utf8');
      expect(() => parse(name, text)).toThrow('no rows');
    }
  });
});
