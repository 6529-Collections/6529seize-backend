import { identitiesDb, IdentitiesDb } from '@/identities/identities.db';
import { RequestContext } from '@/request.context';

export interface HelpBotMentionResolver {
  resolveMentionHandles(
    handles: readonly string[],
    ctx: RequestContext
  ): Promise<string[]>;
}

export class IdentitiesHelpBotMentionResolver implements HelpBotMentionResolver {
  constructor(
    private readonly identitiesDb: Pick<IdentitiesDb, 'getIdsByHandles'>
  ) {}

  public async resolveMentionHandles(
    handles: readonly string[],
    ctx: RequestContext
  ): Promise<string[]> {
    if (!handles.length) {
      return [];
    }
    const idsByCurrentHandle = await this.identitiesDb.getIdsByHandles(
      [...handles],
      ctx.connection
    );
    const currentHandleByNormalized = new Map(
      Object.keys(idsByCurrentHandle).map((handle) => [
        handle.toLowerCase(),
        handle
      ])
    );
    const seen = new Set<string>();
    const resolvedHandles: string[] = [];
    for (const handle of handles) {
      const currentHandle = currentHandleByNormalized.get(handle.toLowerCase());
      if (!currentHandle) {
        continue;
      }
      const key = currentHandle.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      resolvedHandles.push(currentHandle);
    }
    return resolvedHandles;
  }
}

export const helpBotMentionResolver = new IdentitiesHelpBotMentionResolver(
  identitiesDb
);
