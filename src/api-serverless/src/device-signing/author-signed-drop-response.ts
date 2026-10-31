import { DbPoolName } from '@/db-query.options';
import { Logger } from '@/logging';
import { RequestContext } from '@/request.context';
import { deviceSigningDb, DeviceSigningDb } from './device-signing.db';

const logger = Logger.get('AuthorSignedDropResponse');

interface AuthorSignableDrop {
  readonly id: string;
  readonly is_author_signed?: boolean;
  readonly moderation?: { readonly can_view: boolean };
}

/**
 * A device signed create or edit maps its response drop before the author
 * signature is stored, so the mapped is_author_signed is stale. Re-read it from
 * the primary once the signed write has finished. The write already succeeded,
 * so a failed read keeps the mapped value instead of failing the request.
 */
export async function withStoredAuthorSignature<T extends AuthorSignableDrop>(
  drop: T,
  ctx: RequestContext,
  db: Pick<DeviceSigningDb, 'findAuthorSignedDropIds'> = deviceSigningDb
): Promise<T> {
  if (drop.moderation?.can_view === false) {
    return drop;
  }
  try {
    const signedDropIds = await db.findAuthorSignedDropIds(
      [drop.id],
      { timer: ctx.timer },
      DbPoolName.WRITE
    );
    return { ...drop, is_author_signed: signedDropIds.has(drop.id) };
  } catch (error) {
    logger.error(
      `Failed to read the author signature status of drop ${drop.id}`,
      error
    );
    return drop;
  }
}
