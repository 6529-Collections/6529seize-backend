import type { ApiDropWithoutWave } from '@/api/generated/models/ApiDropWithoutWave';
import { applyCollaborationPresentation } from './meme-collaboration-presentation';

function artwork(id: string): ApiDropWithoutWave {
  return {
    id,
    metadata: [{ data_key: 'artist', data_value: 'Artist A' }],
    parts: [],
    reply_to: null
  } as unknown as ApiDropWithoutWave;
}

it('credits every reply and quote copy, including repeated ids, without recursing through cycles', () => {
  const root = artwork('root');
  const reply = artwork('submission');
  const quote = artwork('submission');
  root.reply_to = { drop: reply } as ApiDropWithoutWave['reply_to'];
  root.parts = [
    { quoted_drop: { drop: quote } }
  ] as ApiDropWithoutWave['parts'];
  reply.reply_to = { drop: root } as ApiDropWithoutWave['reply_to'];
  const profile = { id: 'B', handle: 'B', display: 'B', pfp: null };
  applyCollaborationPresentation(
    root,
    { submission: [profile] },
    {
      submission: {
        submission_artist: '',
        credit: { artist: 'Artist A, B', artist_profiles: 'A, B', collab: true }
      }
    }
  );
  for (const copy of [reply, quote]) {
    expect(copy.collaborators).toEqual([profile]);
    expect(copy.submission_artist).toBe('');
    expect(copy.metadata[0].data_value).toBe('Artist A, B');
  }
  expect(root.collaborators).toEqual([]);
});
