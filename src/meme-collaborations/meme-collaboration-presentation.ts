import type { ApiDropWithoutWave } from '@/api/generated/models/ApiDropWithoutWave';
import type {
  CollaboratorProfile,
  MemeCollaborationsDb
} from './meme-collaborations.db';
import { collaborationMetadataValues } from './meme-collaboration-credit';

type Presentations = Awaited<
  ReturnType<MemeCollaborationsDb['presentationByDrops']>
>;

/** Apply accepted credit to each embedded copy before the moderation pass. */
export function applyCollaborationPresentation(
  drop: ApiDropWithoutWave,
  collaborators: Record<string, CollaboratorProfile[]>,
  presentations: Presentations,
  visited = new WeakSet<ApiDropWithoutWave>()
): void {
  if (visited.has(drop)) return;
  visited.add(drop);
  drop.collaborators = collaborators[drop.id] ?? [];
  const presentation = presentations[drop.id];
  if (presentation) {
    drop.submission_artist = presentation.submission_artist;
    const values = collaborationMetadataValues(presentation.credit);
    drop.metadata = drop.metadata.map((item) => ({
      ...item,
      data_value: values.get(item.data_key) ?? item.data_value
    }));
  }
  if (drop.reply_to?.drop)
    applyCollaborationPresentation(
      drop.reply_to.drop,
      collaborators,
      presentations,
      visited
    );
  for (const part of drop.parts) {
    if (part.quoted_drop?.drop)
      applyCollaborationPresentation(
        part.quoted_drop.drop,
        collaborators,
        presentations,
        visited
      );
  }
}
