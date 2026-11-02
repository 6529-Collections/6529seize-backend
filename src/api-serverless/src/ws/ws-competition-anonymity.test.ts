import { ApiDrop } from '@/api/generated/models/ApiDrop';
import {
  anonymizeDropBroadcast,
  getEmbeddedDropIds
} from '@/api/ws/ws-competition-anonymity';
import { serializeDropUpdateForRecipient } from '@/api/ws/ws-listeners-notifier';
import { WsMessageType } from '@/api/ws/ws-message';

function submission(id: string, content = 'Artwork'): ApiDrop {
  return {
    id,
    serial_no: 1,
    author: {
      id: 'real-author',
      handle: 'real-handle',
      primary_address: 'real-wallet',
      subscribed_actions: []
    },
    wave: { id: 'wave' },
    parts: [{ content }],
    submission_artist: 'real-credit',
    collaborators: [{ id: 'real-collaborator' }]
  } as unknown as ApiDrop;
}

describe('anonymous competition WebSocket delivery', () => {
  it('redacts the entry, embedded quotes and reply author without mutating business data', () => {
    const drop = submission('entry');
    drop.parts[0].quoted_drop = {
      drop_id: 'quoted',
      drop_part_id: 1,
      drop: submission('quoted')
    };
    drop.reply_to = {
      drop_id: 'replied',
      drop_part_id: 1,
      is_deleted: false,
      drop: submission('replied')
    };
    expect(getEmbeddedDropIds(drop)).toEqual(['entry', 'quoted', 'replied']);

    const result = anonymizeDropBroadcast(
      drop,
      new Set(['entry', 'quoted', 'replied'])
    );
    expect(JSON.stringify(result)).not.toContain('real-');
    expect(result.author).toMatchObject({
      handle: 'Anonymous',
      is_anonymous: true
    });
    expect(result.author.id).not.toBe(
      result.parts[0].quoted_drop?.drop?.author.id
    );
    expect(drop.author.id).toBe('real-author');
    expect(drop.submission_artist).toBe('real-credit');
  });

  it('does not reveal another entry after one submission by that author wins', () => {
    const winner = submission('winner');
    winner.parts[0].quoted_drop = {
      drop_id: 'still-active',
      drop_part_id: 1,
      drop: submission('still-active')
    };
    const result = anonymizeDropBroadcast(winner, new Set(['still-active']));
    expect(result.author.id).toBe('real-author');
    expect(result.parts[0].quoted_drop?.drop?.author.handle).toBe('Anonymous');
  });

  it('keeps oversized fallback references anonymous', () => {
    const result = anonymizeDropBroadcast(
      submission('entry', 'x'.repeat(40_000)),
      new Set(['entry'])
    );
    const payload = serializeDropUpdateForRecipient(result, 0);
    const parsed = JSON.parse(payload);
    expect(parsed.type).toBe(WsMessageType.DROP_UPDATE_REF);
    expect(parsed.data.author_id).toBe(result.author.id);
    expect(payload).not.toContain('real-');
  });
});
