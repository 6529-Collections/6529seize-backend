import { DropModerationStatus } from '@/entities/IContentModeration';
import { applyCollaborationPresentation } from '@/meme-collaborations/meme-collaboration-presentation';
import { DropsMappers } from './drops.mappers';

function drop(id: string, content: string): any {
  return {
    id,
    title: content,
    parts: [
      {
        content,
        media: [{ url: 'private' }],
        attachments: [],
        quoted_drop: null
      }
    ],
    reply_to: null,
    referenced_nfts: [],
    mentioned_users: [],
    mentioned_groups: [],
    mentioned_waves: [],
    metadata: [],
    reactions: [],
    nft_links: []
  };
}

describe('DropsMappers moderation presentation', () => {
  it('redacts a repeated drop id even when recursion is cycle-limited', () => {
    const root = drop('root', 'root');
    const firstCopy = drop('repeated', 'first secret');
    const repeatedCopy = drop('repeated', 'second secret');
    firstCopy.submission_artist = 'first secret artist';
    repeatedCopy.submission_artist = 'second secret artist';
    root.parts[0].quoted_drop = { drop: firstCopy };
    firstCopy.parts[0].quoted_drop = { drop: repeatedCopy };
    const mapper = new DropsMappers(
      null as any,
      null as any,
      null as any,
      null as any,
      null as any,
      null as any,
      null as any,
      null as any,
      null as any,
      null as any,
      null as any,
      null as any,
      null as any,
      null as any,
      null as any,
      null as any
    );

    applyCollaborationPresentation(
      root,
      {},
      {
        repeated: {
          submission_artist: 'private original artist',
          credit: {
            artist: 'Private A, B',
            artist_profiles: 'A, B',
            collab: true
          }
        }
      }
    );
    expect(firstCopy.submission_artist).toBe('private original artist');
    expect(repeatedCopy.submission_artist).toBe('private original artist');
    (mapper as any).applyModerationPresentation(
      root,
      {
        repeated: {
          viewer: { author_blocked: false, drop_hidden: false },
          moderation: {
            status: DropModerationStatus.MODERATOR_REMOVED,
            can_view: false
          }
        }
      },
      new Set<string>()
    );

    expect(firstCopy.parts[0].content).toBeNull();
    expect(repeatedCopy.parts[0].content).toBeNull();
    expect(repeatedCopy.title).toBeNull();
    expect(firstCopy.submission_artist).toBeUndefined();
    expect(repeatedCopy.submission_artist).toBeUndefined();
  });
});
