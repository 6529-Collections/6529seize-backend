import { randomUUID } from 'node:crypto';
import { RequestContext } from '@/request.context';
import { ARTWORK_ASSETS_TABLE } from '@/artwork-documentation/assets/artwork-assets.types';
import { ArtworkDocumentationService } from './artwork-documentation.service';
import { existingCoordinatorGrant } from './artwork-documentation-coordinator-access';
import {
  getProfile,
  validateProfileAnswers
} from './artwork-documentation.catalogue';
import {
  AD_ARTIST_REVISIONS,
  AD_CONTEXTS,
  AD_EVENTS,
  AD_REVISIONS
} from './artwork-documentation.tables';
import { Answers, ContextRecord } from './artwork-documentation.types';
import { parseJson } from './artwork-documentation.db';
import { digest, fail } from './artwork-documentation.validation';

const PROGRAM_ID = '6529NM-AP-01';
const ACTION = 'upgrade_empty_keys_and_gates_publication_v2';
type UpgradeEvent = {
  correlation_id: string;
  coordinator_profile_id: string;
  apply: boolean;
};
type UpgradeResult = {
  context_id: string;
  status: 'eligible' | 'upgraded' | 'skipped';
  reason?: string;
};

async function upgradeBlocker(
  context: ContextRecord,
  service: ArtworkDocumentationService,
  ctx: RequestContext
): Promise<string | null> {
  if (
    context.profile.profile_id !== 'keys_and_gates_v1' ||
    context.profile.version !== 1
  )
    return 'NOT_LEGACY_KEYS_PROFILE';
  if (context.lifecycle !== 'active') return 'CONTEXT_ARCHIVED';
  if (
    Object.values(context.modules).some(
      (answers) => Object.keys(answers).length
    )
  )
    return 'ANSWERS_EXIST';
  if (context.asset_links.length || context.restricted_paths.length)
    return 'ASSETS_OR_RESTRICTIONS_EXIST';
  if (context.latest_revision_id) return 'REVISION_EXISTS';
  for (const [table, reason] of [
    [AD_REVISIONS, 'REVISION_EXISTS'],
    [ARTWORK_ASSETS_TABLE, 'UPLOAD_OR_ASSET_EXISTS']
  ] as const) {
    const present = await service.db.one<{ id: string }>(
      `SELECT id FROM ${table} WHERE context_id=:id LIMIT 1${ctx.connection ? ' FOR UPDATE' : ''}`,
      { id: context.id },
      ctx
    );
    if (present) return reason;
  }
  if (context.artist_record_revision_id) {
    const pin = await service.db.one<{ answers_json: unknown }>(
      `SELECT answers_json FROM ${AD_ARTIST_REVISIONS} WHERE id=:id AND owner_profile_id=:owner`,
      {
        id: context.artist_record_revision_id,
        owner: context.owner_profile_id
      },
      ctx
    );
    if (!pin) return 'ARTIST_PIN_UNAVAILABLE';
    try {
      validateProfileAnswers(
        getProfile('keys_and_gates_v1', 2),
        'identity',
        parseJson<Answers>(pin.answers_json)
      );
    } catch {
      return 'ARTIST_PIN_INCOMPATIBLE';
    }
  }
  return null;
}

async function inspectProgram(
  event: UpgradeEvent,
  service: ArtworkDocumentationService,
  ctx: RequestContext
): Promise<UpgradeResult[]> {
  await existingCoordinatorGrant(
    event.coordinator_profile_id,
    service,
    ctx,
    event.apply
  );
  const rows = await service.db.query<{ id: string }>(
    `SELECT id FROM ${AD_CONTEXTS} WHERE program_id=:program ORDER BY id LIMIT 201`,
    { program: PROGRAM_ID },
    ctx
  );
  if (rows.length > 200) fail(409, 'COORDINATOR_VERIFICATION_LIMIT');
  const results: UpgradeResult[] = [];
  for (const row of rows) {
    const context = await service.db.context(row.id, ctx, event.apply);
    if (!context || context.program_id !== PROGRAM_ID)
      fail(409, 'PROGRAM_CONTEXT_CHANGED');
    const reason = await upgradeBlocker(context, service, ctx);
    if (reason) {
      results.push({ context_id: row.id, status: 'skipped', reason });
      continue;
    }
    if (event.apply) {
      context.profile = getProfile('keys_and_gates_v1', 2);
      context.draft_version++;
      context.updated_at = Date.now();
      await service.db.saveContext(context, ctx);
      await service.db.insert(
        AD_EVENTS,
        {
          id: randomUUID(),
          context_id: row.id,
          actor_profile_id: event.coordinator_profile_id,
          kind: 'operator_publication_profile_upgraded',
          references_json: JSON.stringify({
            correlation_id: event.correlation_id,
            from_version: 1,
            to_version: 2
          }),
          created_at: Date.now()
        },
        ctx
      );
    }
    results.push({
      context_id: row.id,
      status: event.apply ? 'upgraded' : 'eligible'
    });
  }
  return results;
}

export async function upgradeEmptyKeysAndGatesPublication(
  event: UpgradeEvent,
  service: ArtworkDocumentationService
) {
  if (!event.apply)
    return {
      correlation_id: event.correlation_id,
      mode: 'dry_run',
      program_id: PROGRAM_ID,
      contexts: await inspectProgram(event, service, {})
    };
  return service.db.idempotent(
    digest([ACTION, event.correlation_id]),
    digest({
      action: ACTION,
      coordinator_profile_id: event.coordinator_profile_id
    }),
    {},
    async (ctx) => {
      const previous = await service.db.one<{
        kind: string;
        actor_profile_id: string;
        references_json: unknown;
      }>(
        `SELECT kind,actor_profile_id,references_json FROM ${AD_EVENTS} WHERE id=:id`,
        { id: event.correlation_id },
        ctx
      );
      if (previous) {
        if (
          previous.kind !== ACTION ||
          previous.actor_profile_id !== event.coordinator_profile_id
        )
          fail(409, 'IDEMPOTENCY_MISMATCH');
        return parseJson<Record<string, unknown>>(previous.references_json);
      }
      const result = {
        correlation_id: event.correlation_id,
        mode: 'applied',
        program_id: PROGRAM_ID,
        contexts: await inspectProgram(event, service, ctx)
      };
      await service.db.insert(
        AD_EVENTS,
        {
          id: event.correlation_id,
          context_id: '00000000-0000-0000-0000-000000000000',
          actor_profile_id: event.coordinator_profile_id,
          kind: ACTION,
          references_json: JSON.stringify(result),
          created_at: Date.now()
        },
        ctx
      );
      return result;
    }
  );
}
