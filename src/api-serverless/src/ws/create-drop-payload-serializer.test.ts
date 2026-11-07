import fc from 'fast-check';
import { createDropPayloadSerializer } from '@/api/ws/ws-listeners-notifier';
import { DropUpdateRefType, WsMessageType } from '@/api/ws/ws-message';
import { ApiDrop } from '@/api/generated/models/ApiDrop';
import { ApiDropModerationStatus } from '@/api/generated/models/ApiDropModerationStatus';

const PROFILES = ['author-a', 'author-b', 'reader-c', 'reader-d', 'reader-e'];
const STATUSES = Object.values(ApiDropModerationStatus);

type Tree = {
  id: string;
  author: string;
  status: ApiDropModerationStatus;
  quotes: Tree[];
  reply: Tree | null;
};

function toDrop(tree: Tree, withWave: boolean): ApiDrop {
  const drop: any = {
    id: tree.id,
    serial_no: 1,
    drop_type: 'CHAT',
    title: 'title',
    author: { id: tree.author, subscribed_actions: [] },
    moderation: { status: tree.status, can_view: true },
    viewer_context: { author_blocked: false, drop_hidden: false },
    referenced_nfts: [],
    mentioned_users: [],
    mentioned_groups: [],
    mentioned_waves: [],
    metadata: [],
    reactions: [],
    nft_links: [],
    parts: [
      {
        part_id: 1,
        content: `content of ${tree.id}`,
        media: [],
        attachments: [],
        quoted_drop: null
      },
      ...tree.quotes.map((quote, index) => ({
        part_id: index + 2,
        content: null,
        media: [],
        attachments: [],
        quoted_drop: {
          drop_id: quote.id,
          drop_part_id: 1,
          drop: toDrop(quote, false)
        }
      }))
    ],
    reply_to: tree.reply
      ? {
          drop_id: tree.reply.id,
          drop_part_id: 1,
          drop: toDrop(tree.reply, false)
        }
      : null
  };
  if (withWave) {
    drop.wave = { id: 'wave-1', visibility_group_id: null };
  }
  return drop as ApiDrop;
}

const leafFields = {
  id: fc.constantFrom('d1', 'd2', 'd3', 'd4', 'd5'),
  author: fc.constantFrom(...PROFILES),
  status: fc.constantFrom(...STATUSES)
};

/** Drop trees up to `depth` levels deep, with quotes and reply targets. */
function treeOfDepth(depth: number): fc.Arbitrary<Tree> {
  return depth <= 1
    ? fc.record({
        ...leafFields,
        quotes: fc.constant([] as Tree[]),
        reply: fc.constant(null)
      })
    : fc.record({
        ...leafFields,
        quotes: fc.array(treeOfDepth(depth - 1), { maxLength: 2 }),
        reply: fc.option(treeOfDepth(depth - 1), { nil: null })
      });
}

const treeArb = treeOfDepth(3);

const viewerContextArb = fc.record({
  author_blocked: fc.boolean(),
  drop_hidden: fc.boolean()
});

describe('createDropPayloadSerializer', () => {
  it('gives every recipient exactly the payload the per-recipient path built', () => {
    fc.assert(
      fc.property(
        treeArb,
        fc.dictionary(fc.constantFrom(...PROFILES), viewerContextArb),
        fc.dictionary(
          fc.constantFrom(...PROFILES),
          fc.integer({ min: 0, max: 3 })
        ),
        fc.subarray(['d1', 'd2', 'd3', 'd4', 'd5']),
        fc.dictionary(
          fc.constantFrom('d1', 'd2', 'd3', 'd4', 'd5'),
          fc.constantFrom(...PROFILES)
        ),
        fc.array(fc.option(fc.constantFrom(...PROFILES), { nil: null }), {
          minLength: 1,
          maxLength: 20
        }),
        fc.constantFrom<DropUpdateRefType>(
          WsMessageType.DROP_UPDATE,
          WsMessageType.DROP_RATING_UPDATE,
          WsMessageType.DROP_REACTION_UPDATE
        ),
        (
          tree,
          viewerContexts,
          creditLefts,
          hidden,
          realAuthors,
          recipients,
          updateType
        ) => {
          const audienceDrop = toDrop(tree, true);
          const input = {
            audienceDrop,
            hiddenDropIds: new Set(hidden),
            authorIdsByDropId: new Map(Object.entries(realAuthors)),
            viewerContexts,
            creditLefts,
            updateType
          } as const;
          const before = JSON.stringify(audienceDrop);
          const shared = createDropPayloadSerializer(input);
          for (const profileId of recipients) {
            // A fresh serializer has an empty cache: the pre-1.2 path.
            const expected = createDropPayloadSerializer(input)(profileId);
            expect(shared(profileId)).toBe(expected);
          }
          // Building payloads never mutates the shared audience drop.
          expect(JSON.stringify(audienceDrop)).toBe(before);
        }
      ),
      { numRuns: 300 }
    );
  });

  it('serializes a plain chat message once for a large audience', () => {
    const serialized = jest.fn();
    const payloadFor = createDropPayloadSerializer({
      audienceDrop: toDrop(
        {
          id: 'd1',
          author: 'author-a',
          status: ApiDropModerationStatus.Visible,
          quotes: [],
          reply: null
        },
        true
      ),
      hiddenDropIds: new Set(),
      authorIdsByDropId: new Map(),
      viewerContexts: {},
      creditLefts: {},
      updateType: WsMessageType.DROP_UPDATE,
      onSerialized: serialized
    });
    const payloads = new Set(
      Array.from({ length: 1000 }, (_, index) =>
        payloadFor(index % 7 === 0 ? null : `reader-${index}`)
      )
    );
    expect(payloads.size).toBe(1);
    expect(serialized).toHaveBeenCalledTimes(1);
  });

  it('separates the author of a quarantined drop from everyone else', () => {
    const payloadFor = createDropPayloadSerializer({
      audienceDrop: toDrop(
        {
          id: 'd1',
          author: 'author-a',
          status: ApiDropModerationStatus.AiQuarantined,
          quotes: [],
          reply: null
        },
        true
      ),
      hiddenDropIds: new Set(),
      authorIdsByDropId: new Map(),
      viewerContexts: {
        'reader-c': { author_blocked: true, drop_hidden: false }
      },
      creditLefts: {},
      updateType: WsMessageType.DROP_UPDATE
    });
    const author = JSON.parse(payloadFor('author-a')).data;
    const reader = JSON.parse(payloadFor('reader-d')).data;
    const blocked = JSON.parse(payloadFor('reader-c')).data;
    expect(author.moderation.can_view).toBe(true);
    expect(author.parts[0].content).toBe('content of d1');
    expect(reader.moderation.can_view).toBe(false);
    expect(reader.parts[0].content).toBeNull();
    expect(blocked.viewer_context.author_blocked).toBe(true);
    expect(payloadFor(null)).toBe(payloadFor('reader-d'));
  });
});
