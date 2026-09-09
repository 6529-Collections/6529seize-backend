import { randomUUID } from 'crypto';
import { AuthenticationContext } from '@/auth-context';
import { PROFILES_TABLE } from '@/constants';
import { doInDbContext } from '@/secrets';
import { artworkDocumentationService as service } from './artwork-documentation.service';
import { AD_EVENTS, AD_GRANTS } from './artwork-documentation.tables';
import { emptyCapabilities } from './artwork-documentation.access';
import { fail } from './artwork-documentation.validation';
import { parseJson } from './artwork-documentation.db';
import { Capabilities } from './artwork-documentation.types';

export const KEYS_AND_GATES_SOURCE_DROP_IDS = [
  'c3283930-101e-4e3a-b921-57d81649ca81',
  '35efbf4c-2633-4b14-aa6a-82ea7660b6b9',
  'b47b7d58-6276-45ba-b707-ec0f623e39e2',
  '57c49f95-7854-4a2a-ba2c-d448bc7827fc',
  '52631c54-fcce-46e7-b88c-5100de46734c',
  '73ecf8fc-9bde-492d-a624-39d0dd547587',
  'f24313f0-b335-4c16-9052-3a689f82f188',
  'aa257b16-4309-48b6-9033-1e3d7fb9016d',
  'a9e1af00-7ac7-4b7d-a39e-31c7a662ee28',
  'd68542bc-f05e-4f23-ae8b-fac730cd4b7b',
  '52b6f536-3ebc-4bf5-b7da-2ed775df7ad3',
  '7d3a31f8-41bf-4fc5-8756-ed67eccdcc96',
  '51982d19-395a-4eaa-866c-8e89aa952cbb',
  'dc75fe32-f3c2-49db-9069-d9975b5964f3',
  '8ac2b1b8-64f9-48ef-b41b-04ee3a9ba3ab',
  '13407a59-3b86-4a04-b68e-87e818ed3766'
] as const;
const PROGRAM_ID = '6529NM-AP-01';
const WAVE_ID = '4ff022b3-aa17-4a0a-ba78-58f64ff1d427';

export async function importKeysAndGates(
  coordinatorProfileId: string,
  apply: boolean
) {
  const ctx = {
    authenticationContext:
      AuthenticationContext.fromProfileId(coordinatorProfileId)
  };
  const profile = await service.db.one<{ external_id: string }>(
    `SELECT external_id FROM ${PROFILES_TABLE} WHERE external_id=:id LIMIT 1`,
    { id: coordinatorProfileId },
    ctx
  );
  if (!profile) fail(422, 'COORDINATOR_PROFILE_NOT_FOUND');
  const sources = [];
  for (const id of KEYS_AND_GATES_SOURCE_DROP_IDS) {
    const drop = await service.getDrop(id, ctx);
    if (drop.wave_id !== WAVE_ID) fail(422, 'SOURCE_WAVE_MISMATCH');
    sources.push({
      drop_id: id,
      owner_profile_id: drop.author_id,
      wave_id: drop.wave_id
    });
  }
  if (!apply)
    return {
      mode: 'dry_run',
      coordinator_profile_id: coordinatorProfileId,
      program_id: PROGRAM_ID,
      sources
    };
  service.actor(ctx);
  await service.db.executeNativeQueriesInTransaction(async (connection) => {
    const transaction = { ...ctx, connection };
    const existing = await service.db.query<{ capabilities_json: unknown }>(
      `SELECT capabilities_json FROM ${AD_GRANTS} WHERE context_id IS NULL AND program_id=:program AND subject_profile_id=:actor AND revoked_at IS NULL FOR UPDATE`,
      { program: PROGRAM_ID, actor: coordinatorProfileId },
      transaction
    );
    if (
      existing.some(
        (row) =>
          parseJson<Capabilities>(row.capabilities_json).manage_assignments
      )
    )
      return;
    const grantId = randomUUID();
    await service.db.insert(
      AD_GRANTS,
      {
        id: grantId,
        context_id: null,
        program_id: PROGRAM_ID,
        subject_profile_id: coordinatorProfileId,
        capabilities_json: JSON.stringify({
          ...emptyCapabilities(),
          read_context: true,
          manage_assignments: true,
          manage_context: true
        }),
        grantor_profile_id: coordinatorProfileId,
        revoked_at: null,
        created_at: Date.now()
      },
      transaction
    );
    await service.db.insert(
      AD_EVENTS,
      {
        id: randomUUID(),
        context_id: '00000000-0000-0000-0000-000000000000',
        actor_profile_id: coordinatorProfileId,
        kind: 'operator_program_coordinator_assigned',
        references_json: JSON.stringify({
          program_id: PROGRAM_ID,
          grant_id: grantId
        }),
        created_at: Date.now()
      },
      transaction
    );
  });
  const results = [];
  for (const source of sources) {
    const body = {
      profile_id: 'keys_and_gates_v1',
      profile_version: 1,
      program_id: PROGRAM_ID,
      source_drop_id: source.drop_id,
      start_mode: 'coordinator_import'
    };
    const context = await service.createWork(
      body,
      { key: source.drop_id, route: 'operator:keys-and-gates-pilot-v1', body },
      ctx
    );
    results.push({
      drop_id: source.drop_id,
      context_id: context.id,
      work_id: context.work_id,
      owner_profile_id: context.owner_profile_id
    });
  }
  return {
    mode: 'applied',
    program_id: PROGRAM_ID,
    coordinator_profile_id: coordinatorProfileId,
    contexts: results
  };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const coordinatorIndex = args.indexOf('--coordinator-profile-id');
  const coordinator =
    coordinatorIndex >= 0 ? args[coordinatorIndex + 1] : undefined;
  if (
    !coordinator ||
    !/^[a-f\d-]{36}$/i.test(coordinator) ||
    args.some(
      (value, index) =>
        !['--apply', '--coordinator-profile-id'].includes(value) &&
        index !== coordinatorIndex + 1
    )
  ) {
    process.stderr.write(
      'Usage: artwork-documentation-pilot --coordinator-profile-id <verified-profile-UUID> [--apply]\n'
    );
    process.exitCode = 1;
  } else {
    doInDbContext(
      () => importKeysAndGates(coordinator, args.includes('--apply')),
      { skipRedis: true, syncEntities: false }
    )
      .then((result) =>
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
      )
      .catch(() => {
        process.stderr.write(
          'Pilot operation failed. No private records are included in this error. Verify the target environment, feature configuration and source identifiers.\n'
        );
        process.exitCode = 1;
      });
  }
}
