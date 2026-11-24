import {
  DropPartRowForArchive,
  DropRowForArchive
} from '@/waves-import-files/drop-archive.build';

/**
 * Made-up rows for archive tests: two waves, a two-part drop, a reply, a
 * quote, a native entry, a winner, escapes and text outside ASCII. The
 * expected values below are what the snapshot tooling
 * (tools/legacy-snapshot: waves_fetch.compact_drop, waves_model.archive_row,
 * ce.canonical_json) writes for the API drops of these rows.
 */
const WAVE_A = '22222222-2222-4222-8222-000000000001';
const WAVE_B = '22222222-2222-4222-8222-000000000002';
const DROP = (n: number) => `11111111-1111-4111-8111-00000000000${n}`;
const PROFILE = (n: number) => `33333333-3333-4333-8333-00000000000${n}`;

export const FIXTURE_WAVES = { a: WAVE_A, b: WAVE_B } as const;

export const FIXTURE_DROPS: DropRowForArchive[] = [
  {
    id: DROP(1),
    serial_no: 7,
    wave_id: WAVE_A,
    author_id: PROFILE(1),
    created_at: 1_700_000_000_123,
    updated_at: null,
    title: null,
    reply_to_drop_id: null,
    reply_to_part_id: null,
    drop_type: 'CHAT'
  },
  {
    id: DROP(2),
    serial_no: 9,
    wave_id: WAVE_A,
    author_id: PROFILE(2),
    created_at: 1_700_000_001_000,
    updated_at: 1_700_000_002_000,
    title: 'A title with "quotes" and é',
    reply_to_drop_id: DROP(1),
    reply_to_part_id: 2,
    drop_type: 'PARTICIPATORY'
  },
  {
    id: DROP(3),
    serial_no: 8,
    wave_id: WAVE_A,
    author_id: PROFILE(1),
    created_at: 1_700_000_000_500,
    updated_at: null,
    title: null,
    reply_to_drop_id: DROP(1),
    reply_to_part_id: null,
    drop_type: 'COMPETITION'
  },
  {
    id: DROP(4),
    serial_no: 20,
    wave_id: WAVE_B,
    author_id: PROFILE(3),
    created_at: 1_700_000_005_000,
    updated_at: null,
    title: null,
    reply_to_drop_id: null,
    reply_to_part_id: null,
    drop_type: 'WINNER'
  }
];

export const FIXTURE_PARTS: (DropPartRowForArchive & { wave_id: string })[] = [
  {
    drop_id: DROP(1),
    drop_part_id: 2,
    content: 'second part\nwith a newline and a tab\t',
    quoted_drop_id: null,
    quoted_drop_part_id: null,
    wave_id: WAVE_A
  },
  {
    drop_id: DROP(1),
    drop_part_id: 1,
    content: 'first part \u{1F30A} \u0001 \\ / </script>',
    quoted_drop_id: null,
    quoted_drop_part_id: null,
    wave_id: WAVE_A
  },
  {
    drop_id: DROP(2),
    drop_part_id: 1,
    content: null,
    quoted_drop_id: DROP(1),
    quoted_drop_part_id: 1,
    wave_id: WAVE_A
  },
  {
    drop_id: DROP(3),
    drop_part_id: 1,
    content: 'an entry',
    quoted_drop_id: null,
    quoted_drop_part_id: null,
    wave_id: WAVE_A
  },
  {
    drop_id: DROP(4),
    drop_part_id: 1,
    content: 'a winner   line separator',
    quoted_drop_id: null,
    quoted_drop_part_id: null,
    wave_id: WAVE_B
  }
];

/** What the snapshot tooling writes for the rows above. */
export const FIXTURE_EXPECTED = {
  archives: [
    {
      legacyWave: WAVE_A,
      waveId:
        '0xbcae0ad924b2565bc4c96405e2c3e66f9f1ff30e959f657ab419e0e0298a0cee',
      hash: '0xa2454634a0f57adf10e4de5dc880ea0cee06bb175f9669cc0b015c58da4ab873',
      bytes: 2117
    },
    {
      legacyWave: WAVE_B,
      waveId:
        '0xf776cf6e58f415903662f759dba2776ee0a4e942e7149fa1c25a1bc553b37bc4',
      hash: '0x706e74e9430535f73e39ef3c2d2cd22051a285237de0bebc86daa92099426c24',
      bytes: 606
    }
  ],
  dropArchiveRoot:
    '0x9303884aba60c3f4bfdd993d41df4616d42883874a66a01f559bb4ee0fb52130',
  /** The first line's author_principal, DerivedId(profile 1, 0, 0x0101). */
  firstPrincipal:
    '2b87e4b5bf45418194c54400858ff77838ee526b87a6946d03ec0da9d963ac15'
} as const;
