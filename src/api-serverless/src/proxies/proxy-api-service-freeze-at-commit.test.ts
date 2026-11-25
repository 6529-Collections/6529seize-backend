import { ProfileProxyActionType } from '@/entities/IProfileProxyAction';
import { profileActivityLogsDb } from '@/profileActivityLogs/profile-activity-logs.db';
import {
  expectCommitted,
  expectRefusedAtCommit,
  fakeTransactionalDb,
  freezeClock
} from '@/tests/fixtures/freeze-at-commit.fixture';
import { AcceptActionRequestActionEnum } from '../generated/models/AcceptActionRequest';
import { ApiProfileProxyActionType } from '../generated/models/ApiProfileProxyActionType';
import { ProfileProxyApiService } from './proxy.api.service';

const CREATOR = 'creator-profile-id';
const TARGET = 'target-profile-id';

const API_TYPE: Partial<
  Record<ProfileProxyActionType, ApiProfileProxyActionType>
> = {
  [ProfileProxyActionType.ALLOCATE_REP]: ApiProfileProxyActionType.AllocateRep,
  [ProfileProxyActionType.ALLOCATE_CIC]: ApiProfileProxyActionType.AllocateCic,
  [ProfileProxyActionType.CREATE_DROP_TO_WAVE]:
    ApiProfileProxyActionType.CreateDropToWave
};

/**
 * A proxy service whose writes run in a transaction of the real
 * my-sql.helpers on a fake connection. Every write calls `onWrite`, where a
 * row lock would be waited on.
 */
function setup(
  actionType: ProfileProxyActionType,
  state: { accepted_at?: number; revoked_at?: number } = {},
  onWrite: () => void
) {
  const tx = fakeTransactionalDb();
  const action = {
    id: 'action-1',
    proxy_id: 'proxy-1',
    action_type: actionType,
    credit_amount: 10,
    credit_spent: 0,
    end_time: null,
    accepted_at: state.accepted_at ?? null,
    rejected_at: null,
    revoked_at: state.revoked_at ?? null,
    is_active: true
  };
  const write = jest.fn(async () => onWrite());
  const profileProxiesDb = {
    executeNativeQueriesInTransaction: tx.executeNativeQueriesInTransaction,
    findProfileProxyActionsByProxyIdAndActionType: jest
      .fn()
      .mockResolvedValue([]),
    findProfileProxyActionById: jest.fn().mockResolvedValue(action),
    findProfileProxyById: jest.fn().mockResolvedValue({
      id: 'proxy-1',
      created_by: CREATOR,
      target_id: TARGET
    }),
    findProfileProxyActionsByProxyId: jest.fn().mockResolvedValue([action]),
    insertProfileProxyAction: jest.fn(async () => {
      onWrite();
      return { actionId: action.id };
    }),
    acceptProfileProxyAction: write,
    rejectProfileProxyAction: write,
    revokeProfileProxyAction: write,
    restoreProfileProxyAction: write,
    updateProfileProxyAction: write
  };
  const mapper = {
    profileProxyEntitiesToApiProfileProxies: jest.fn().mockResolvedValue([
      {
        id: 'proxy-1',
        created_by: { id: CREATOR },
        granted_to: { id: TARGET },
        actions: [action]
      }
    ])
  };
  jest
    .spyOn(profileActivityLogsDb, 'insert')
    .mockResolvedValue(undefined as any);
  const service = new ProfileProxyApiService(
    {} as any,
    profileProxiesDb as any,
    mapper as any
  );
  return { tx, service, profileProxiesDb, write };
}

const FROZEN_TYPES = [
  ProfileProxyActionType.ALLOCATE_REP,
  ProfileProxyActionType.ALLOCATE_CIC
];

type Step = 'persist' | AcceptActionRequestActionEnum | 'update';

/** Runs one proxy action write, with the action in the state it needs. */
function runStep(
  step: Step,
  actionType: ProfileProxyActionType,
  onWrite: () => void
) {
  const state =
    step === AcceptActionRequestActionEnum.Reject ||
    step === AcceptActionRequestActionEnum.Revoke
      ? { accepted_at: 1 }
      : step === AcceptActionRequestActionEnum.Restore
        ? { revoked_at: 1 }
        : {};
  const fixture = setup(actionType, state, onWrite);
  const { service } = fixture;
  const hasCredit = FROZEN_TYPES.includes(actionType);
  let run: Promise<unknown>;
  if (step === 'persist') {
    run = service.createProfileProxyAction({
      proxy: {
        id: 'proxy-1',
        created_by: { id: CREATOR },
        granted_to: { id: TARGET }
      } as any,
      action: {
        action_type: API_TYPE[actionType],
        ...(hasCredit ? { credit_amount: 10 } : {})
      } as any
    });
  } else if (step === 'update') {
    run = service.updateProfileProxyAction({
      proxy_id: 'proxy-1',
      action_id: 'action-1',
      profile_id: CREATOR,
      ...(hasCredit ? { credit_amount: 20 } : { end_time: null })
    });
  } else {
    run = service.changeProfileProxyActionStatus({
      proxy_id: 'proxy-1',
      action_id: 'action-1',
      acceptance_type: step,
      profile_id:
        step === AcceptActionRequestActionEnum.Accept ||
        step === AcceptActionRequestActionEnum.Reject
          ? TARGET
          : CREATOR
    });
  }
  return { ...fixture, run };
}

const STEPS: Step[] = [
  'persist',
  AcceptActionRequestActionEnum.Accept,
  AcceptActionRequestActionEnum.Reject,
  AcceptActionRequestActionEnum.Revoke,
  AcceptActionRequestActionEnum.Restore,
  'update'
];

const cases = FROZEN_TYPES.flatMap((type) =>
  STEPS.map((step) => [step, type] as const)
);

describe('a REP or NIC proxy allocation write admitted before the identity freeze that commits after it', () => {
  let clock: ReturnType<typeof freezeClock>;
  beforeEach(() => {
    clock = freezeClock();
  });
  afterEach(() => {
    clock.restore();
    jest.restoreAllMocks();
  });

  it.each(cases)(
    '%s of %s is refused at COMMIT and rolls back',
    async (step, type) => {
      const { run, tx, profileProxiesDb } = runStep(step, type, () =>
        clock.pass()
      );
      await expectRefusedAtCommit(run, tx.statements);
      const wrote =
        step === 'persist'
          ? profileProxiesDb.insertProfileProxyAction
          : profileProxiesDb.acceptProfileProxyAction;
      expect(wrote).toHaveBeenCalledWith(
        expect.objectContaining({
          connection: expect.objectContaining({ connection: tx.connection })
        })
      );
    }
  );

  it.each(cases)(
    '%s of %s commits when it ends before T',
    async (step, type) => {
      const { run, tx } = runStep(step, type, () => undefined);
      await run;
      expectCommitted(tx.statements);
    }
  );

  it.each(STEPS)(
    '%s of a wave proxy action is not checked at COMMIT',
    async (step) => {
      const { run, tx } = runStep(
        step,
        ProfileProxyActionType.CREATE_DROP_TO_WAVE,
        () => clock.pass()
      );
      await run;
      expectCommitted(tx.statements);
    }
  );
});
