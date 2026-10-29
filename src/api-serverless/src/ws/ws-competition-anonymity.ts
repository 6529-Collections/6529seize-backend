import { ApiDrop } from '@/api/generated/models/ApiDrop';
import { ApiDropWithoutWave } from '@/api/generated/models/ApiDropWithoutWave';
import { anonymousCompetitionAuthor } from '@/competitions/competition-anonymity';

type EmbeddedDrop = ApiDrop | ApiDropWithoutWave;

function visitDrops(
  drop: EmbeddedDrop,
  visit: (candidate: EmbeddedDrop) => void,
  seen = new Set<EmbeddedDrop>()
): void {
  if (seen.has(drop)) return;
  seen.add(drop);
  visit(drop);
  for (const part of drop.parts) {
    if (part.quoted_drop?.drop) visitDrops(part.quoted_drop.drop, visit, seen);
  }
  if (drop.reply_to?.drop) visitDrops(drop.reply_to.drop, visit, seen);
}

export function getEmbeddedDropIds(drop: ApiDrop): string[] {
  const ids = new Set<string>();
  visitDrops(drop, (candidate) => ids.add(candidate.id));
  return Array.from(ids);
}

/** Apply after moderation has used real ownership, immediately before delivery. */
export function anonymizeDropBroadcast(
  drop: ApiDrop,
  hiddenDropIds: ReadonlySet<string>
): ApiDrop {
  if (!hiddenDropIds.size) return drop;
  const result = structuredClone(drop);
  visitDrops(result, (candidate) => {
    if (!hiddenDropIds.has(candidate.id)) return;
    candidate.author = anonymousCompetitionAuthor(
      candidate.author,
      candidate.id
    );
    delete candidate.submission_artist;
    candidate.collaborators = [];
  });
  return result;
}
