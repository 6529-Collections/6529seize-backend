import { compactDrop, stableGrant } from './waves-export.compact';
import { pythonJson } from './waves-export.json';

/**
 * API drops (made-up values) and the rows the waves snapshot tooling's
 * Python `compact_drop` writes for them, with `json.dumps(row,
 * ensure_ascii=False)` (tools/legacy-snapshot/waves_fetch.py, validator
 * commit 34d84750e). The export must write the same bytes.
 */
const API_DROPS: unknown[] = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    serial_no: 5,
    author: {
      id: 'aaaaaaaa-0000-4000-8000-000000000001',
      handle: 'alice'
    },
    created_at: 1700000000000,
    updated_at: null,
    drop_type: 'CHAT',
    title: null,
    parts: [
      {
        part_id: 1,
        content: 'hello @[alice] see #[wave]',
        media: [
          {
            url: 'https://media.example/a.png',
            mime_type: 'image/png',
            extra: 1
          }
        ],
        attachments: [
          {
            attachment_id: 'att-1',
            file_name: 'f.pdf',
            mime_type: 'application/pdf',
            url: 'https://media.example/f.pdf',
            kind: 'PDF',
            status: 'READY',
            size: 10
          }
        ],
        quoted_drop: {
          drop_id: '22222222-2222-4222-8222-222222222222',
          drop_part_id: 2,
          drop: {
            id: 'x'
          }
        }
      }
    ],
    metadata: [
      {
        data_key: 'k',
        data_value: 'v'
      }
    ],
    reply_to: {
      drop_id: '33333333-3333-4333-8333-333333333333',
      drop_part_id: 1,
      is_deleted: false
    },
    mentioned_users: [
      {
        mentioned_profile_id: 'aaaaaaaa-0000-4000-8000-000000000001',
        handle_in_content: 'alice',
        current_handle: 'alice'
      }
    ],
    mentioned_groups: ['ALL'],
    mentioned_waves: [
      {
        wave_id: 'w-1',
        wave_name_in_content: 'wave'
      },
      {
        id: 'w-2',
        wave_name_in_content: 'other'
      }
    ],
    referenced_nfts: [
      {
        contract: '0x0000000000000000000000000000000000000001',
        token: '7',
        name: 'Card'
      }
    ],
    nft_links: [
      {
        url_in_text: 'https://market.example/nft/1',
        data: {
          canonical_id: 'c-1',
          chain: 'eth',
          contract: '0x01',
          token: '1',
          platform: 'market',
          price: 1e-5
        }
      }
    ],
    reactions: [
      {
        reaction: '\uff01',
        profiles: [
          {
            id: 'p1'
          }
        ]
      },
      {
        reaction: '\ud83d\ude00',
        profiles: [
          {
            id: 'p1'
          },
          {
            id: 'p2'
          }
        ]
      },
      {
        reaction: ':+1:',
        profiles: []
      }
    ],
    is_author_signed: true,
    is_signed: true,
    moderation: {
      status: 'VISIBLE',
      can_view: true,
      score: 1e-5
    },
    collaborators: [
      {
        id: 'c2'
      },
      {
        profile: {
          id: 'c1'
        }
      },
      {
        id: null
      },
      'x'
    ]
  },
  {
    id: '44444444-4444-4444-8444-444444444444',
    serial_no: 6,
    author: null,
    created_at: 1700000001000,
    drop_type: 'PARTICIPATORY',
    parts: [],
    reply_to: {
      drop: {
        id: '55555555-5555-4555-8555-555555555555'
      },
      drop_part_id: 3
    },
    mentioned_users: null,
    reactions: null,
    is_author_signed: false,
    metadata: []
  },
  {
    id: '66666666-6666-4666-8666-666666666666',
    serial_no: 7,
    wave: {
      id: 'w-9'
    },
    parts: [
      {
        part_id: 1,
        content: null,
        media: null,
        attachments: null,
        quoted_drop: null
      }
    ],
    mentioned_waves: [
      {
        wave_id: '',
        id: 'w-3',
        wave_name_in_content: 'x'
      }
    ],
    reply_to: {},
    collaborators: []
  }
];

const PYTHON_ROWS: string[] = [
  '{"id": "11111111-1111-4111-8111-111111111111", "serial_no": 5, "wave_id": null, "author": "aaaaaaaa-0000-4000-8000-000000000001", "created_at": 1700000000000, "updated_at": null, "drop_type": "CHAT", "title": null, "parts": [{"part_id": 1, "content": "hello @[alice] see #[wave]", "media": [{"url": "https://media.example/a.png", "mime_type": "image/png"}], "attachments": [{"attachment_id": "att-1", "file_name": "f.pdf", "kind": "PDF", "mime_type": "application/pdf", "status": "READY", "url": "https://media.example/f.pdf"}], "quoted_drop": {"drop_id": "22222222-2222-4222-8222-222222222222", "part_id": 2}}], "metadata": [{"data_key": "k", "data_value": "v"}], "reply_to": {"drop_id": "33333333-3333-4333-8333-333333333333", "part_id": 1}, "mentioned_users": [{"profile_id": "aaaaaaaa-0000-4000-8000-000000000001", "handle_in_content": "alice"}], "mentioned_groups": ["ALL"], "mentioned_waves": [{"wave_id": "w-1", "name_in_content": "wave"}, {"wave_id": "w-2", "name_in_content": "other"}], "referenced_nfts": [{"contract": "0x0000000000000000000000000000000000000001", "token": "7", "name": "Card"}], "nft_links": [{"url_in_text": "https://market.example/nft/1", "canonical_id": "c-1", "chain": "eth", "contract": "0x01", "token": "1", "platform": "market"}], "reactions": [{"reaction": ":+1:", "count": 0}, {"reaction": "\uff01", "count": 1}, {"reaction": "\ud83d\ude00", "count": 2}], "is_author_signed": true, "is_signed": true, "moderation": {"status": "VISIBLE", "can_view": true, "score": 1e-05}, "collaborators": ["c1", "c2"]}',
  '{"id": "44444444-4444-4444-8444-444444444444", "serial_no": 6, "wave_id": null, "author": null, "created_at": 1700000001000, "updated_at": null, "drop_type": "PARTICIPATORY", "title": null, "parts": [], "metadata": [], "reply_to": {"drop_id": "55555555-5555-4555-8555-555555555555", "part_id": 3}, "mentioned_users": [], "mentioned_groups": [], "mentioned_waves": [], "referenced_nfts": [], "nft_links": [], "reactions": [], "is_author_signed": false, "is_signed": false, "moderation": null, "collaborators": []}',
  '{"id": "66666666-6666-4666-8666-666666666666", "serial_no": 7, "wave_id": "w-9", "author": null, "created_at": null, "updated_at": null, "drop_type": null, "title": null, "parts": [{"part_id": 1, "content": null, "media": [], "attachments": [], "quoted_drop": null}], "metadata": [], "reply_to": null, "mentioned_users": [], "mentioned_groups": [], "mentioned_waves": [{"wave_id": "w-3", "name_in_content": "x"}], "referenced_nfts": [], "nft_links": [], "reactions": [], "is_author_signed": false, "is_signed": false, "moderation": null, "collaborators": []}'
];

describe('compactDrop', () => {
  it.each(API_DROPS.map((drop, index) => [index, drop]))(
    "writes drop %i as the snapshot tooling's compact_drop does",
    (index, drop) => {
      expect(pythonJson(compactDrop(drop))).toBe(PYTHON_ROWS[index as number]);
    }
  );

  it('reads a drop with no optional field', () => {
    expect(compactDrop({ id: 'd', serial_no: 1 })).toEqual({
      id: 'd',
      serial_no: 1,
      wave_id: null,
      author: null,
      created_at: null,
      updated_at: null,
      drop_type: null,
      title: null,
      parts: [],
      metadata: [],
      reply_to: null,
      mentioned_users: [],
      mentioned_groups: [],
      mentioned_waves: [],
      referenced_nfts: [],
      nft_links: [],
      reactions: [],
      is_author_signed: false,
      is_signed: false,
      moderation: null,
      collaborators: []
    });
  });
});

describe('stableGrant', () => {
  it('drops the use counter only', () => {
    expect(
      stableGrant({ id: 'g', wallet: '0x01', last_used_at: 5, scope: 'post' })
    ).toEqual({ id: 'g', wallet: '0x01', scope: 'post' });
  });
});
