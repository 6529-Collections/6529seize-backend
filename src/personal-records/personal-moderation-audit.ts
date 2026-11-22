import { RequestContext } from '@/request.context';
import {
  RecordChange,
  RecordHeadKey,
  RecordHeadStore,
  RecordIndexer,
  RecordRegistry,
  RecordTypeHandler,
  SenderKeyring
} from '@/signed-records/record-index';
import {
  compareOrderKeys,
  importOrderKey,
  RecordOrderKey
} from '@/signed-records/record-order';
import type { VerifiedRecord } from '@/signed-records/record-verify';
import type { ProviderKey } from '@/signed-records/sealed-crypto';
import {
  latestImport,
  PersonalImportBody,
  PersonalImportDone,
  rebuildPersonalState,
  ReportEffect
} from './personal-import';
import {
  moderationLogOf,
  PERSONAL_MODERATION_LOG_TYPE,
  PersonalHandlerDeps,
  PersonalModerationAction,
  personalRecordHandlers,
  PersonalRecordType
} from './personal-record-types';
import type { RecordOwnerDirectory } from './record-owner-directory';

/** One row of content_moderation_audit_log, without its generated id. */
export interface PersonalModerationAuditRow {
  readonly actorProfileId: string;
  readonly action: PersonalModerationAction;
  readonly targetProfileId: string | null;
  readonly targetDropId: string | null;
  readonly previousState: string;
  readonly newState: string;
  readonly createdAt: number;
}

// Only the handlers' body checks run here; their table deps are never called.
const UNUSED_DEPS = new Proxy(
  {},
  {
    get: () => () => {
      throw new Error('Only the body checks run here');
    }
  }
) as never as PersonalHandlerDeps;

/** Heads in memory: this pass writes no table. */
class MemoryHeads implements RecordHeadStore {
  private readonly heads = new Map<string, RecordOrderKey>();

  private static id(key: RecordHeadKey): string {
    return `${key.owner}|${key.family}|${key.type}|${key.key}`;
  }

  async lock(key: RecordHeadKey): Promise<RecordOrderKey | null> {
    return this.heads.get(MemoryHeads.id(key)) ?? null;
  }

  async put(key: RecordHeadKey, order: RecordOrderKey): Promise<void> {
    this.heads.set(MemoryHeads.id(key), order);
  }

  async inTransaction<T>(
    ctx: RequestContext,
    fn: (ctx: RequestContext) => Promise<T>
  ): Promise<T> {
    return fn(ctx);
  }
}

// As the handlers: an imported or report change carries its own time.
function timeOf(change: RecordChange): number {
  return change.eventId === null && typeof change.body?.at === 'number'
    ? change.body.at
    : change.order.claimedTime;
}

/**
 * The audit rows of people's own blocks and hides (PROFILE_BLOCKED,
 * PROFILE_UNBLOCKED, DROP_HIDDEN, DROP_UNHIDDEN), as today's routes and the
 * live records wrote them:
 * 1. the import's history, each row at its stored time, oldest first;
 * 2. a row per block, unblock, hide and unhide applied after the import
 *    (records and drop reports, in the rebuild's order), at the change's
 *    own time, with today's transitions: a block of a profile already
 *    blocked, or an unblock of one not blocked, writes none; a hide or an
 *    unhide always writes one, with the state it found, even for a drop
 *    deleted since (live keeps that row).
 * The audit log's rebuild inserts them in this order. Nothing here changes
 * a table: the rebuild of the personal tables writes no audit row.
 */
export async function personalModerationAuditRows(args: {
  readonly imports: readonly (PersonalImportBody | PersonalImportDone)[];
  readonly records: readonly VerifiedRecord[];
  readonly reportEffects?: readonly ReportEffect[];
  readonly providers: readonly ProviderKey[];
  readonly owners: Pick<RecordOwnerDirectory, 'profileIdOf'>;
}): Promise<PersonalModerationAuditRow[]> {
  const { done, imported } = latestImport(args.imports);
  const importOrder = done ? importOrderKey(done.anchor, done.at) : null;
  const history: (PersonalModerationAuditRow & { readonly id: bigint })[] = [];
  for (const body of imported) {
    const actorProfileId = await args.owners.profileIdOf(body.owner);
    if (!actorProfileId) continue;
    for (const item of body.items) {
      if (item.t !== PERSONAL_MODERATION_LOG_TYPE) continue;
      const log = moderationLogOf({
        owner: body.owner,
        family: body.family,
        type: item.t,
        key: item.k,
        body: item.b,
        order: importOrderKey(body.anchor, body.at),
        eventId: null,
        sealedClass: 1,
        writer: 'author'
      });
      const isProfile = log.action.startsWith('PROFILE_');
      const targetProfileId = isProfile
        ? await args.owners.profileIdOf(log.target)
        : null;
      if (isProfile && !targetProfileId) continue;
      history.push({
        id: BigInt(item.k),
        actorProfileId,
        action: log.action,
        targetProfileId,
        targetDropId: isProfile ? null : log.target,
        previousState: log.previous,
        newState: log.next,
        createdAt: log.at
      });
    }
  }
  history.sort((a, b) =>
    a.createdAt !== b.createdAt
      ? a.createdAt - b.createdAt
      : Number(a.id > b.id) - Number(a.id < b.id)
  );

  const rows: PersonalModerationAuditRow[] = [];
  const blocked = new Set<string>();
  const hidden = new Set<string>();
  const isImported = (change: RecordChange) =>
    importOrder !== null && compareOrderKeys(change.order, importOrder) === 0;
  const applyBlock = async (change: RecordChange) => {
    const actor = await args.owners.profileIdOf(change.owner);
    const target = actor ? await args.owners.profileIdOf(change.key) : null;
    if (!actor || !target || actor === target) return;
    const pair = `${actor}|${target}`;
    const on = change.body !== null;
    if (!isImported(change) && on !== blocked.has(pair)) {
      rows.push({
        actorProfileId: actor,
        action: on ? 'PROFILE_BLOCKED' : 'PROFILE_UNBLOCKED',
        targetProfileId: target,
        targetDropId: null,
        previousState: on ? 'UNBLOCKED' : 'BLOCKED',
        newState: on ? 'BLOCKED' : 'UNBLOCKED',
        createdAt: timeOf(change)
      });
    }
    if (on) blocked.add(pair);
    else blocked.delete(pair);
  };
  const applyHide = async (change: RecordChange) => {
    const actor = await args.owners.profileIdOf(change.owner);
    if (!actor) return;
    const on = change.body !== null;
    // A hide accepted live wrote its row while the drop existed, and that
    // row outlives the drop: keep it even when the drop is gone now.
    const pair = `${actor}|${change.key}`;
    if (!isImported(change)) {
      rows.push({
        actorProfileId: actor,
        action: on ? 'DROP_HIDDEN' : 'DROP_UNHIDDEN',
        targetProfileId: null,
        targetDropId: change.key,
        previousState: hidden.has(pair) ? 'HIDDEN' : 'SHOWN',
        newState: on ? 'HIDDEN' : 'SHOWN',
        createdAt: timeOf(change)
      });
    }
    if (on) hidden.add(pair);
    else hidden.delete(pair);
  };

  // The rebuild's own order and stale checks, with every type's body
  // check; only blocks and hides do anything.
  const registry = new RecordRegistry();
  for (const handler of personalRecordHandlers(UNUSED_DEPS)) {
    const apply: RecordTypeHandler['apply'] =
      handler.type === PersonalRecordType.BLOCK
        ? applyBlock
        : handler.type === PersonalRecordType.HIDE
          ? applyHide
          : async () => undefined;
    registry.register({ ...handler, apply });
  }
  await rebuildPersonalState({
    indexer: new RecordIndexer({
      registry,
      heads: new MemoryHeads(),
      keyring: new SenderKeyring(args.providers)
    }),
    imports: args.imports,
    records: args.records,
    reportEffects: args.reportEffects,
    ctx: {}
  });
  return [...history.map(({ id: _id, ...row }) => row), ...rows];
}
