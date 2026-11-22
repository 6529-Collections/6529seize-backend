import type { PersonalImportBody, ReportEffect } from './personal-import';
import { personalModerationAuditRows } from './personal-moderation-audit';
import { FixtureOwnerDirectory } from './personal-records.test-fixtures';

const P_ME = `0x${'0'.repeat(63)}1`;
const P_ALICE = `0x${'0'.repeat(63)}2`;
const P_BOB = `0x${'0'.repeat(63)}3`;
const owners = new FixtureOwnerDirectory(
  new Map([
    [P_ME, 'me'],
    [P_ALICE, 'alice'],
    [P_BOB, 'bob']
  ])
);

function importOf(items: PersonalImportBody['items']): PersonalImportBody {
  return { v: 1, anchor: 1000, at: 5000, owner: P_ME, family: 'pv', items };
}

let n = 0;
function report(effect: Partial<ReportEffect>): ReportEffect {
  n++;
  return {
    reporter: P_ME,
    dropId: 'drop-1',
    author: null,
    hideDrop: null,
    blockAuthor: null,
    order: {
      anchor: 1001,
      claimedTime: 6000 + n,
      eventId: `0x${n.toString(16).padStart(64, '0')}`
    },
    ...effect
  };
}

const rowsOf = (
  imports: PersonalImportBody[],
  reportEffects: ReportEffect[] = []
) =>
  personalModerationAuditRows({
    imports: [
      ...imports,
      { v: 1, anchor: 1000, at: 5000, done: true, entries: imports.length }
    ],
    records: [],
    reportEffects,
    providers: [],
    owners
  });

const history = (
  k: string,
  action: string,
  target: string,
  previous: string,
  next: string,
  at: number
) => ({
  t: 'moderation-log',
  k,
  b: { action, target, previous, next, at }
});

describe('personalModerationAuditRows', () => {
  beforeEach(() => {
    n = 0;
  });

  it("returns the import's history oldest first, each row at its stored time", async () => {
    const rows = await rowsOf([
      importOf([
        history('12', 'DROP_HIDDEN', 'drop-1', 'SHOWN', 'HIDDEN', 200),
        history('11', 'PROFILE_BLOCKED', P_ALICE, 'UNBLOCKED', 'BLOCKED', 200),
        history('3', 'PROFILE_UNBLOCKED', P_BOB, 'BLOCKED', 'UNBLOCKED', 100)
      ])
    ]);
    expect(rows).toEqual([
      {
        actorProfileId: 'me',
        action: 'PROFILE_UNBLOCKED',
        targetProfileId: 'bob',
        targetDropId: null,
        previousState: 'BLOCKED',
        newState: 'UNBLOCKED',
        createdAt: 100
      },
      // The same time: the audit row id decides, as today's order does.
      {
        actorProfileId: 'me',
        action: 'PROFILE_BLOCKED',
        targetProfileId: 'alice',
        targetDropId: null,
        previousState: 'UNBLOCKED',
        newState: 'BLOCKED',
        createdAt: 200
      },
      {
        actorProfileId: 'me',
        action: 'DROP_HIDDEN',
        targetProfileId: null,
        targetDropId: 'drop-1',
        previousState: 'SHOWN',
        newState: 'HIDDEN',
        createdAt: 200
      }
    ]);
  });

  it("writes today's transitions after the import, from the state the import left", async () => {
    const rows = await rowsOf(
      [
        importOf([
          { t: 'block', k: P_ALICE, b: { at: 50 } },
          { t: 'hide', k: 'drop-1', b: { at: 60 } }
        ])
      ],
      [
        // Blocked and hidden at the import: no block row; a hide always
        // writes one, with the state it found.
        report({ author: P_ALICE, blockAuthor: true, hideDrop: true }),
        // A new block, and a hide of a drop deleted since: live kept its
        // row when the drop went, so the rebuild writes it too.
        report({ author: P_BOB, blockAuthor: true }),
        report({ dropId: 'drop-gone', hideDrop: true })
      ]
    );
    expect(
      rows.map((row) => [
        row.action,
        row.targetProfileId ?? row.targetDropId,
        row.previousState,
        row.createdAt
      ])
    ).toEqual([
      ['DROP_HIDDEN', 'drop-1', 'HIDDEN', 6001],
      ['PROFILE_BLOCKED', 'bob', 'UNBLOCKED', 6002],
      ['DROP_HIDDEN', 'drop-gone', 'SHOWN', 6003]
    ]);
  });

  it('leaves out a block of yourself and of an unknown profile', async () => {
    const rows = await rowsOf(
      [importOf([])],
      [
        report({ author: P_ME, blockAuthor: true }),
        report({ author: `0x${'0'.repeat(63)}9`, blockAuthor: true })
      ]
    );
    expect(rows).toEqual([]);
  });
});
