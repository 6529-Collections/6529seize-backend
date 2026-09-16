import { RequestContext } from '@/request.context';
import { ConnectionWrapper, dbSupplier } from '@/sql-executor';
import { isMembershipSourceTrackingActive } from './membership-producer-policy';
import {
  MembershipPrimaryContext,
  withMembershipPrimaryMutationContext,
  withMembershipPrimaryTransaction
} from './membership-primary';
import {
  MembershipSourceJobIdentity,
  MembershipSourceJobState,
  MembershipSourceJobsDb,
  MEMBERSHIP_TDH_COMPLETION_STAGE
} from './membership-source-jobs.db';
import {
  membershipGlobalMutation,
  membershipProducerJobId
} from './membership-producer-writes';

const jobs = new MembershipSourceJobsDb(dbSupplier);
const INPUTS_COMMITTED = 'TDH_INPUTS_COMMITTED';
const UNIVERSE_COMMITTED = 'UNIVERSE_COMMITTED';

export type MembershipTdhCycleKind = 'tdh-full' | 'delegation';

export function membershipTdhCycleId(
  kind: MembershipTdhCycleKind,
  source: readonly (string | number)[]
): string {
  const opaqueId = membershipProducerJobId(kind, source);
  if (kind !== 'tdh-full') return opaqueId;
  const calculationDate = source[0];
  if (
    typeof calculationDate !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/.test(calculationDate)
  )
    return opaqueId;
  // Retain the exact calculation date so a STARTED cycle can replay after UTC
  // midnight without silently changing its underlying TDH source range.
  return `tdh-full:${calculationDate}:${opaqueId.slice(-16)}`;
}

export function membershipTdhCycleCalculationDate(cycleId: string): Date {
  const match = cycleId.match(
    /^tdh-full:(\d{4}-\d{2}-\d{2}T00:00:00\.000Z):[0-9a-f]{16}$/
  );
  if (!match) throw new Error('TDH cycle has no replayable calculation date');
  const date = new Date(match[1]);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== match[1])
    throw new Error('TDH cycle has an invalid calculation date');
  return date;
}

function cycleIdentity(cycleId: string): MembershipSourceJobIdentity {
  const kind = cycleId.split(':', 1)[0];
  if (kind !== 'tdh-full' && kind !== 'delegation')
    throw new Error('Invalid membership TDH cycle ID');
  const dimensions =
    kind === 'delegation'
      ? ([
          'TDH_XTDH',
          'RATINGS',
          'IDENTITY',
          'GRANTS',
          'OWNERSHIP',
          'DELEGATIONS'
        ] as const)
      : (['TDH_XTDH', 'RATINGS', 'IDENTITY', 'GRANTS'] as const);
  return {
    job_id: cycleId,
    keys: membershipGlobalMutation(dimensions, 'tdh-source-cycle').keys
  };
}

export async function startMembershipTdhCycle(
  cycleId: string,
  ctx: RequestContext = {}
): Promise<MembershipSourceJobState | null> {
  if (!isMembershipSourceTrackingActive()) return null;
  const identity = cycleIdentity(cycleId);
  return withMembershipPrimaryTransaction(
    dbSupplier(),
    async (primary) => {
      const state = await jobs.start(
        identity,
        { stage: 'STARTED', after_id: null },
        primary
      );
      return state.status === 'FAILED'
        ? jobs.resume(identity, state.progress, primary)
        : state;
    },
    ctx
  );
}

export async function checkpointMembershipTdhInputs(
  cycleId: string,
  ctx: RequestContext = {},
  writeFinalInputs: (
    ctx: MembershipPrimaryContext
  ) => Promise<void> = async () => undefined
): Promise<void> {
  if (!isMembershipSourceTrackingActive()) return;
  const identity = cycleIdentity(cycleId);
  await withMembershipPrimaryTransaction(
    dbSupplier(),
    async (primary) => {
      const state = await jobs.get(identity, primary);
      if (
        state.status === 'COMPLETED' ||
        state.progress.stage === INPUTS_COMMITTED
      )
        return;
      if (state.status !== 'RUNNING' || state.progress.stage !== 'STARTED')
        throw new Error('TDH inputs cannot advance from this producer stage');
      await jobs.checkpoint(
        identity,
        state.progress,
        { stage: INPUTS_COMMITTED, after_id: null },
        writeFinalInputs,
        primary
      );
    },
    ctx
  );
}

export async function failMembershipTdhCycle(
  cycleId: string,
  ctx: RequestContext = {}
): Promise<void> {
  if (!isMembershipSourceTrackingActive()) return;
  const identity = cycleIdentity(cycleId);
  await withMembershipPrimaryTransaction(
    dbSupplier(),
    async (primary) => {
      const state = await jobs.get(identity, primary);
      if (state.status === 'RUNNING')
        await jobs.fail(identity, state.progress, 'TDH_SOURCE_FAILED', primary);
    },
    ctx
  );
}

export async function checkpointMembershipTdhUniverse(
  cycleId: string,
  connection: ConnectionWrapper<unknown>,
  write: () => Promise<void>,
  ctx: RequestContext = {}
): Promise<boolean> {
  if (!isMembershipSourceTrackingActive()) {
    await write();
    return true;
  }
  const identity = cycleIdentity(cycleId);
  const { connection: _connection, ...requestCtx } = ctx;
  return withMembershipPrimaryMutationContext(
    connection,
    async (primary) => {
      const state = await jobs.get(identity, primary);
      if (
        state.status === 'COMPLETED' ||
        state.progress.stage === UNIVERSE_COMMITTED ||
        state.progress.stage === MEMBERSHIP_TDH_COMPLETION_STAGE
      )
        return false;
      if (
        state.status !== 'RUNNING' ||
        state.progress.stage !== INPUTS_COMMITTED
      )
        throw new Error('TDH universe cannot advance from this producer stage');
      await jobs.checkpoint(
        identity,
        state.progress,
        { stage: UNIVERSE_COMMITTED, after_id: null },
        write,
        primary
      );
      return true;
    },
    requestCtx
  );
}

export async function getMembershipTdhCycleState(
  cycleId: string,
  ctx: RequestContext = {}
): Promise<MembershipSourceJobState | null> {
  if (!isMembershipSourceTrackingActive()) return null;
  return withMembershipPrimaryTransaction(
    dbSupplier(),
    (primary) => jobs.find(cycleIdentity(cycleId), primary),
    ctx
  );
}

export async function findActiveMembershipTdhCycle(
  ctx: RequestContext = {}
): Promise<{ cycleId: string; state: MembershipSourceJobState } | null> {
  if (!isMembershipSourceTrackingActive()) return null;
  return withMembershipPrimaryTransaction(
    dbSupplier(),
    async (primary) => {
      const cycleId = await jobs.findActiveGlobalJobId('TDH_XTDH', primary);
      if (!cycleId) return null;
      return {
        cycleId,
        state: await jobs.get(cycleIdentity(cycleId), primary)
      };
    },
    ctx
  );
}

export async function activateMembershipTdhStats(
  cycleId: string,
  activate: (ctx: MembershipPrimaryContext) => Promise<void>,
  ctx: RequestContext = {}
): Promise<void> {
  if (!isMembershipSourceTrackingActive())
    throw new Error('Inactive TDH cycle cannot activate tracked statistics');
  const identity = cycleIdentity(cycleId);
  await withMembershipPrimaryTransaction(
    dbSupplier(),
    async (primary) => {
      const state = await jobs.get(identity, primary);
      if (
        state.status === 'COMPLETED' ||
        state.progress.stage === MEMBERSHIP_TDH_COMPLETION_STAGE
      )
        return;
      if (
        state.status !== 'RUNNING' ||
        state.progress.stage !== UNIVERSE_COMMITTED
      )
        throw new Error(
          'TDH statistics cannot advance from this producer stage'
        );
      await jobs.checkpoint(
        identity,
        state.progress,
        { stage: MEMBERSHIP_TDH_COMPLETION_STAGE, after_id: null },
        activate,
        primary
      );
    },
    ctx
  );
}

export async function completeMembershipTdhCycle(
  cycleId: string,
  ctx: RequestContext = {}
): Promise<void> {
  if (!isMembershipSourceTrackingActive()) return;
  const identity = cycleIdentity(cycleId);
  await withMembershipPrimaryTransaction(
    dbSupplier(),
    async (primary) => {
      const state = await jobs.get(identity, primary);
      if (state.status === 'COMPLETED') return;
      if (
        state.status !== 'RUNNING' ||
        state.progress.stage !== MEMBERSHIP_TDH_COMPLETION_STAGE
      )
        throw new Error(
          'TDH cycle cannot complete before statistics activation'
        );
      await jobs.complete(
        identity,
        state.progress,
        [{ scope: 'FULL', target_id: '*', reason: 'tdh-source-completed' }],
        async () => undefined,
        primary
      );
    },
    ctx
  );
}
