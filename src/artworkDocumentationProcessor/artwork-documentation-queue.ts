import {
  artworkDocumentationDb,
  ArtworkDocumentationDb
} from '@/artwork-documentation/artwork-documentation.db';
import { AD_DOSSIER_EXPORTS } from '@/artwork-documentation/artwork-documentation.tables';
import { ARTWORK_ASSETS_TABLE } from '@/artwork-documentation/assets/artwork-assets.types';
import { RequestContext } from '@/request.context';

type Queue = 'asset' | 'dossier';
type Processor = { tick(): Promise<boolean> };

/** Priority is advisory; each processor retains its transactional row claim. */
export async function processOldestDocumentationJob(
  processors: Record<Queue, Processor>,
  db: Pick<ArtworkDocumentationDb, 'one'> = artworkDocumentationDb,
  now = Date.now()
): Promise<void> {
  const head = await db.one<{ queue: Queue }>(
    `(SELECT 'asset' AS queue,next_attempt_at AS queued_at,id
      FROM ${ARTWORK_ASSETS_TABLE}
      WHERE state='processing' AND next_attempt_at<=:now AND lease_until<:now
      ORDER BY next_attempt_at,id LIMIT 1)
     UNION ALL
     (SELECT 'dossier' AS queue,created_at AS queued_at,id
      FROM ${AD_DOSSIER_EXPORTS}
      WHERE state IN ('queued','processing') AND lease_until<:now
        AND expires_at>:now AND attempts<3
      ORDER BY created_at,id LIMIT 1)
     ORDER BY queued_at,queue,id LIMIT 1`,
    { now },
    {} as RequestContext
  );
  // Keep cleanup running when neither processing queue has an eligible row.
  const first = head?.queue ?? 'asset';
  const second = first === 'asset' ? 'dossier' : 'asset';
  if (!(await processors[first].tick())) await processors[second].tick();
}
