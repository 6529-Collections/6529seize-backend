import 'reflect-metadata';
import {
  fetchDetailsForConsolidationKey,
  fetchLogsForConsolidationKey,
  fetchUpcomingMemeSubscriptionStatusForConsolidationKey,
  fetchUpcomingMemeSubscriptions
} from '@/api/subscriptions/api.subscriptions.db';
import {
  ADDRESS_CONSOLIDATION_KEY,
  CONSOLIDATED_OWNERS_BALANCES_MEMES_TABLE,
  IDENTITIES_TABLE,
  MEMES_CONTRACT,
  MEMES_SEASONS_TABLE,
  NFTS_TABLE,
  SIGNED_RECORD_HEADS_TABLE,
  SIGNED_RECORD_LOG_ENTRIES_TABLE,
  SUBSCRIPTIONS_BALANCES_TABLE,
  SUBSCRIPTIONS_ID_BALANCES_TABLE,
  SUBSCRIPTIONS_ID_CURSORS_TABLE,
  SUBSCRIPTIONS_ID_LOGS_TABLE,
  SUBSCRIPTIONS_ID_MODE_TABLE,
  SUBSCRIPTIONS_ID_NFTS_FINAL_TABLE,
  SUBSCRIPTIONS_ID_NFTS_TABLE,
  SUBSCRIPTIONS_ID_REDEEMED_TABLE,
  SUBSCRIPTIONS_ID_REPORTS_TABLE,
  SUBSCRIPTIONS_ID_STATE_TABLE,
  SUBSCRIPTIONS_ID_TOP_UP_TABLE,
  SUBSCRIPTIONS_LOGS_TABLE,
  SUBSCRIPTIONS_MODE_TABLE,
  SUBSCRIPTIONS_NFTS_TABLE,
  SUBSCRIPTIONS_TOP_UP_TABLE,
  TRANSACTIONS_PROCESSED_SUBSCRIPTIONS_BLOCKS_TABLE
} from '@/constants';
import { connect, disconnect } from '@/db';
import * as Entities from '@/entities/entities';
import {
  encodeSignedRecordsHeader,
  SignedRecordEvent
} from '@/signed-records/record-event';
import { familyWave } from '@/signed-records/record-families';
import { GrantProofRecordSource } from '@/signed-records/record-grant-proofs';
import { RecordKind } from '@/signed-records/record-kinds';
import { RecordLogEntry } from '@/signed-records/record-log/record-log-format';
import { recordLogDb } from '@/signed-records/record-log/record-log.db';
import { RecordLogWriter } from '@/signed-records/record-log/record-log.service';
import {
  appGrantFixture,
  bindingSource,
  grantSource,
  signedRecord
} from '@/signed-records/record-test-fixtures';
import {
  PrincipalBindingSource,
  VerifiedGrant,
  verifyRecordEvent
} from '@/signed-records/record-verify';
import { signedRecordHeadsDb } from '@/signed-records/signed-record-heads.db';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { mirrorIdentityDirectory } from '../identity/identity-directory';
import {
  closeSubscriptionWrites,
  scheduleIdentitySwitch,
  subscriptionsIdentitySwitch,
  subscriptionWritePathNow
} from '../identity/identity-switch';
import { cutOpeningFiles } from '../opening/opening-build';
import { compareAndMarkVerified } from '../opening/opening-compare';
import {
  IDENTITY_DATA_TABLES,
  loadOpeningFiles,
  ParsedOpening,
  parseOpeningFiles
} from '../opening/opening-load';
import { foldBoundWallets } from '../writers/identity-fold';
import { saveReport } from '../writers/identity-reports';
import { identityTablesHash, journalBodyOf } from '../timeline/journal';
import { JournalSource, rebuildIdentityTables } from '../opening/rebuild';
import { recordContentOf, SubscriptionChange } from './subscription-records';
import {
  legacySubscriptionWrite,
  SubscriptionChangeWriter,
  SubscriptionWriteDeps,
  SubscriptionWriteRequest
} from './subscription-writes';
import * as cutoffModule from '@/api/subscriptions/subscription-cutoff';
import { CustomApiCompliantException } from '@/exceptions';
import { shadowReportsMatch } from '../writers/identity-reports';

jest.mock('@/subscriptionsDaily/subscription-cache', () => ({
  invalidateUpcomingSubscriptionCaches: jest.fn()
}));

/*
 * Signed subscription changes on each write path, against MySQL: the
 * record is verified, matched to the request, applied to the identity
 * tables with its event and journal entry in the record log, and the legacy
 * tables get today's write or the dual write. Records are signed by the
 * fixture device key under a fixture app grant (a test wallet).
 */

/** The principal the grant's wallet is bound to (made up). */
const P = `0x${'c1'.padStart(64, '0')}`;
const OTHER = `0x${'0'.repeat(39)}9`;
const RELEASED = 100;
/** Upcoming cards, open on every weekday (the cutoff is 100 or 101). */
const C1 = 102;
const C2 = 103;
const C3 = 104;
const ANCHOR = 1000;

let fixture: Awaited<ReturnType<typeof appGrantFixture>>;
/** The grant's wallet: the signed-in wallet and its own consolidation key. */
let W: string;
let seq = 1;

const execute = (sql: string, params?: Record<string, unknown>) =>
  sqlExecutor.execute(sql, params);

/** Inserts a row, filling NOT NULL columns without a default with zeros. */
async function insertFilled(table: string, values: Record<string, unknown>) {
  const required = await sqlExecutor.execute<{ c: string; t: string }>(
    `SELECT column_name AS c, data_type AS t FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = :table
        AND is_nullable = 'NO' AND column_default IS NULL
        AND extra NOT LIKE '%auto_increment%'`,
    { table }
  );
  const row: Record<string, unknown> = { ...values };
  for (const { c, t } of required) {
    if (!(c in row)) {
      row[c] = /date|time/.test(t)
        ? '2026-01-01 00:00:00'
        : /char|text/.test(t)
          ? ''
          : 0;
    }
  }
  const columns = Object.keys(row);
  await execute(
    `INSERT INTO ${table} (${columns.map((c) => `\`${c}\``).join(', ')})
      VALUES (${columns.map((c) => `:${c}`).join(', ')})`,
    row
  );
}

/**
 * W holds 0.5 with eligibility 2 and is subscribed to C2; with `bound`, the
 * mirror has W in the identity of principal P.
 */
async function seedLegacy({ bound = true } = {}) {
  await execute(`CREATE TABLE IF NOT EXISTS identity_chain_principals (
    principal_id varchar(66) NOT NULL PRIMARY KEY,
    profile_id varchar(50) NOT NULL UNIQUE,
    origin varchar(20) NOT NULL,
    created_at bigint NOT NULL)`);
  await execute(
    `INSERT INTO ${ADDRESS_CONSOLIDATION_KEY} (address, consolidation_key) VALUES (:w, :w)`,
    { w: W }
  );
  if (bound) {
    await execute(
      `INSERT INTO ${IDENTITIES_TABLE} (consolidation_key, profile_id, primary_address, tdh, rep, cic, level_raw)
        VALUES (:w, 'profile-1', :w, 0, 0, 0, 0)`,
      { w: W }
    );
    await execute(
      `INSERT INTO identity_chain_principals VALUES (:p, 'profile-1', 'LEGACY', 0)`,
      { p: P }
    );
  }
  await execute(
    `INSERT INTO ${SUBSCRIPTIONS_BALANCES_TABLE} (consolidation_key, balance) VALUES (:w, 0.5)`,
    { w: W }
  );
  await execute(
    `INSERT INTO ${SUBSCRIPTIONS_NFTS_TABLE}
      (consolidation_key, contract, token_id, subscribed, subscribed_count, automatic_subscription)
      VALUES (:w, :c, :token, true, 1, false)`,
    { w: W, c: MEMES_CONTRACT, token: C2 }
  );
  await execute(
    `INSERT INTO ${SUBSCRIPTIONS_TOP_UP_TABLE} (hash, block, transaction_date, from_wallet, amount)
      VALUES ('0xa0', 5, '2026-11-01 00:00:00', :w, 0.5)`,
    { w: W }
  );
  await execute(
    `INSERT INTO ${TRANSACTIONS_PROCESSED_SUBSCRIPTIONS_BLOCKS_TABLE} (created_at, block, timestamp)
      VALUES (NOW(), 1, 0)`
  );
  await insertFilled(NFTS_TABLE, {
    id: RELEASED,
    contract: MEMES_CONTRACT,
    mint_date: '2026-11-01 00:00:00'
  });
  await insertFilled(MEMES_SEASONS_TABLE, { id: 1 });
  await insertFilled(CONSOLIDATED_OWNERS_BALANCES_MEMES_TABLE, {
    consolidation_key: W,
    season: 1,
    sets: 2
  });
}

/** Cut, load and verify the opening; with `live`, switch to it now. */
async function cutAndLoad(live: boolean): Promise<ParsedOpening> {
  const files = await cutOpeningFiles(mirrorIdentityDirectory, Date.now());
  const parsed = parseOpeningFiles(files.openingBytes, files.historyBytes);
  await loadOpeningFiles(parsed);
  expect(
    (await compareAndMarkVerified(parsed, mirrorIdentityDirectory)).ok
  ).toBe(true);
  if (live) {
    expect(await scheduleIdentitySwitch(Date.now(), parsed.openingSha256)).toBe(
      true
    );
  }
  subscriptionsIdentitySwitch.invalidate();
  return parsed;
}

function writer(
  options: {
    readonly shadow?: boolean;
    readonly grants?: readonly VerifiedGrant[];
    readonly bindings?: PrincipalBindingSource;
    readonly anchors?: SubscriptionWriteDeps['anchors'];
  } = {}
): SubscriptionChangeWriter {
  return new SubscriptionChangeWriter({
    path: () =>
      subscriptionWritePathNow(Date.now(), options.shadow ? 'true' : undefined),
    grants: grantSource(options.grants ?? [fixture.grant]),
    bindings:
      options.bindings ?? bindingSource([{ wallet: W, principal: P, from: 1 }]),
    anchors: options.anchors ?? {
      getAnchor: async () => ({
        anchor: ANCHOR,
        headHeight: ANCHOR,
        finalizedTime: Date.now(),
        maxAnchorLag: 120
      })
    },
    directory: mirrorIdentityDirectory,
    log: new RecordLogWriter(recordLogDb, {
      findGrantProofs: async (ids) =>
        ids.includes(fixture.proof.id) ? [fixture.proof] : []
    }),
    heads: signedRecordHeadsDb,
    legacy: legacySubscriptionWrite,
    saveReport,
    now: () => Date.now()
  });
}

/** The signed record for a change, by the fixture grant's device. */
function record(
  change: SubscriptionChange,
  options: {
    readonly owner?: string;
    readonly grant?: Pick<VerifiedGrant, 'id' | 'wallet'>;
    readonly anchor?: number;
    readonly claimedTime?: number;
  } = {}
): SignedRecordEvent {
  const content = recordContentOf(change);
  return signedRecord(options.grant ?? fixture.grant, {
    kind: RecordKind.RECORD,
    wave: familyWave('ps', options.owner ?? P),
    refs: content.key === '' ? [content.type] : [content.type, content.key],
    body: content.body,
    seq: seq++,
    anchor: options.anchor ?? ANCHOR,
    claimedTime: options.claimedTime ?? Date.now()
  });
}

const header = (...events: SignedRecordEvent[]) =>
  encodeSignedRecordsHeader(events);

function request(
  change: SubscriptionChange,
  signedRecords: string | undefined,
  overrides: Partial<SubscriptionWriteRequest> = {}
): SubscriptionWriteRequest {
  return {
    routeKey: W,
    wallet: W,
    walletInKey: true,
    signedRecords,
    change,
    ...overrides
  };
}

const card = (token: number, subscribed: boolean): SubscriptionChange => ({
  type: 'subs.card',
  contract: MEMES_CONTRACT,
  tokenId: token,
  subscribed
});
const count = (token: number, n: number): SubscriptionChange => ({
  type: 'subs.count',
  contract: MEMES_CONTRACT,
  tokenId: token,
  count: n
});
const MODE_ON: SubscriptionChange = { type: 'subs.mode', automatic: true };
const ALL_ON: SubscriptionChange = { type: 'subs.all-editions', all: true };

/** A rejection's status, code, reason and message. */
async function refusal(run: Promise<unknown>) {
  try {
    await run;
  } catch (error) {
    const e = error as {
      getStatusCode?: () => number;
      code?: string;
      details?: { reason?: string };
      message: string;
    };
    return {
      status: e.getStatusCode?.(),
      code: e.code,
      reason: e.details?.reason,
      message: e.message
    };
  }
  throw new Error('expected a refusal');
}

/** One side's rows for an identity or key: mode, cards and log lines. */
async function rowsOf(side: 'legacy' | 'identity', key: string) {
  const [keyColumn, mode, nfts, logs] =
    side === 'legacy'
      ? [
          'consolidation_key',
          SUBSCRIPTIONS_MODE_TABLE,
          SUBSCRIPTIONS_NFTS_TABLE,
          SUBSCRIPTIONS_LOGS_TABLE
        ]
      : [
          'identity_key',
          SUBSCRIPTIONS_ID_MODE_TABLE,
          SUBSCRIPTIONS_ID_NFTS_TABLE,
          SUBSCRIPTIONS_ID_LOGS_TABLE
        ];
  return {
    mode: (
      await sqlExecutor.execute<{
        automatic: number;
        subscribe_all_editions: number;
      }>(
        `SELECT automatic, subscribe_all_editions FROM ${mode} WHERE ${keyColumn} = :key`,
        { key }
      )
    ).map((m) => [Number(m.automatic), Number(m.subscribe_all_editions)]),
    cards: (
      await sqlExecutor.execute<{
        token_id: number;
        subscribed: number;
        subscribed_count: number;
        automatic_subscription: number;
      }>(
        `SELECT token_id, subscribed, subscribed_count, automatic_subscription
           FROM ${nfts} WHERE ${keyColumn} = :key ORDER BY token_id`,
        { key }
      )
    ).map((c) => [
      Number(c.token_id),
      Number(c.subscribed),
      Number(c.subscribed_count),
      Number(c.automatic_subscription)
    ]),
    lines: (
      await sqlExecutor.execute<{ log: string; additional_info: string }>(
        `SELECT log, additional_info FROM ${logs} WHERE ${keyColumn} = :key ORDER BY id`,
        { key }
      )
    ).map((l) => [l.log, l.additional_info])
  };
}

/** The record log's public chain, in log order, as a rebuild reads it. */
const journalSource: JournalSource = {
  async *walk() {
    for (const entry of await logEntries()) {
      yield { entry };
    }
  }
};

async function logEntries(): Promise<RecordLogEntry[]> {
  return (
    await sqlExecutor.execute<{ entry: string }>(
      `SELECT entry FROM ${SIGNED_RECORD_LOG_ENTRIES_TABLE} ORDER BY id`
    )
  ).map((row) => JSON.parse(row.entry));
}

async function heads() {
  return sqlExecutor.execute<Record<string, unknown>>(
    `SELECT owner, family, rtype, rkey, anchor, claimed_time, event_id
       FROM ${SIGNED_RECORD_HEADS_TABLE} ORDER BY rtype, rkey`
  );
}

async function reports() {
  return (
    await sqlExecutor.execute<{
      kind: string;
      mode: string;
      verdict: string;
      token_id: number | null;
      report: string | object;
    }>(
      `SELECT kind, mode, verdict, token_id, report FROM ${SUBSCRIPTIONS_ID_REPORTS_TABLE} ORDER BY id`
    )
  ).map((r) => ({
    ...r,
    token_id: r.token_id === null ? null : Number(r.token_id),
    report: typeof r.report === 'string' ? JSON.parse(r.report) : r.report
  }));
}

beforeAll(async () => {
  await connect(
    Object.values(Entities).filter((e) => typeof e === 'function') as never
  );
  fixture = await appGrantFixture();
  W = fixture.grant.wallet;
});

afterAll(async () => {
  await disconnect();
});

describeWithSeed('signed subscription changes', [], () => {
  afterEach(() => {
    subscriptionsIdentitySwitch.invalidate();
  });

  describe('after the switch (IDENTITY)', () => {
    it('applies a valid record, logs its event and journal entry, and dual-writes the legacy tables', async () => {
      await seedLegacy();
      await cutAndLoad(true);
      const event = record(card(C1, true));
      const response = await writer().write(
        request(card(C1, true), header(event))
      );
      expect(response).toEqual({
        consolidation_key: W,
        contract: MEMES_CONTRACT,
        token_id: C1,
        subscribed: true,
        subscribed_count: 1
      });
      expect((await rowsOf('identity', P)).cards).toContainEqual([C1, 1, 1, 0]);
      expect((await rowsOf('legacy', W)).cards).toContainEqual([C1, 1, 1, 0]);
      const entries = await logEntries();
      expect(entries.map((e) => [e.t, e.lane])).toEqual([
        ['event', 'subs'],
        ['entry', 'subs']
      ]);
      expect(entries[0]).toEqual(
        expect.objectContaining({ event, grant: fixture.proof })
      );
      const choice = journalBodyOf(entries[1]);
      expect(choice).toEqual(
        expect.objectContaining({
          kind: 'choice',
          mode: 'truth',
          inputs: {
            event_id: event.id,
            owner: P,
            type: 'subs.card',
            key: `${MEMES_CONTRACT.toLowerCase()}:${C1}`,
            anchor: ANCHOR,
            claimed_time: event.claimed_time,
            identity_key: P
          }
        })
      );
      // The rows it changed, each before and after: the new card row and
      // its log line, both inserts. The mode row and C2 were left alone.
      expect(
        choice!.changes.map((c) => [
          c.table,
          c.before,
          c.table === 'choices'
            ? [
                c.key.identity_key,
                String(c.key.contract).toLowerCase(),
                Number(c.key.token_id),
                Number(c.after?.subscribed),
                Number(c.after?.subscribed_count)
              ]
            : [c.after?.log, c.after?.consolidation_key]
        ])
      ).toEqual([
        ['choices', null, [P, MEMES_CONTRACT.toLowerCase(), C1, 1, 1]],
        ['logs', null, [`Subscribed for Meme #${C1}`, W]]
      ]);
      expect(await heads()).toEqual([
        expect.objectContaining({
          owner: P,
          family: 'ps',
          rtype: 'subs.card',
          event_id: event.id
        })
      ]);
    });

    it('refuses a change without a record with 409, and writes nothing', async () => {
      await seedLegacy();
      await cutAndLoad(true);
      const before = [await rowsOf('identity', P), await rowsOf('legacy', W)];
      expect(
        await refusal(writer().write(request(card(C1, true), undefined)))
      ).toEqual({
        status: 409,
        code: 'SIGNED_RECORD_REQUIRED',
        reason: undefined,
        message:
          'Subscription changes are signed now. Update the app and try again.'
      });
      expect([await rowsOf('identity', P), await rowsOf('legacy', W)]).toEqual(
        before
      );
      expect(await logEntries()).toEqual([]);
    });

    const tampered = (event: SignedRecordEvent): SignedRecordEvent => ({
      ...event,
      signature: `${event.signature.slice(0, -2)}${event.signature.endsWith('00') ? '01' : '00'}`
    });

    interface RecordCase {
      readonly name: string;
      readonly reason: string;
      readonly header: () => Promise<string>;
      readonly grants?: () => Promise<VerifiedGrant[]>;
    }
    const expiredGrant = () => appGrantFixture({ expires_at: 1792411200 });
    const reactGrant = () => appGrantFixture({ scopes: ['react'] });
    const recordCases: RecordCase[] = [
      {
        name: 'a bad signature',
        reason: 'sig',
        header: async () => header(tampered(record(card(C1, true))))
      },
      {
        name: 'an expired grant',
        reason: 'grant-expired',
        header: async () =>
          header(
            record(card(C1, true), { grant: (await expiredGrant()).grant })
          ),
        grants: async () => [(await expiredGrant()).grant]
      },
      {
        name: 'a grant without the post scope',
        reason: 'grant-scope',
        header: async () =>
          header(record(card(C1, true), { grant: (await reactGrant()).grant })),
        grants: async () => [(await reactGrant()).grant]
      },
      {
        name: 'an anchor too far behind the head',
        reason: 'anchor',
        header: async () =>
          header(record(card(C1, true), { anchor: ANCHOR - 121 }))
      },
      {
        name: 'a claimed time far from now',
        reason: 'anchor',
        header: async () =>
          header(
            record(card(C1, true), { claimedTime: Date.now() - 3_600_000 })
          )
      },
      {
        name: 'a record of another change than the request',
        reason: 'mismatch',
        header: async () => header(record(card(C1, false)))
      },
      {
        name: 'a record for another card',
        reason: 'mismatch',
        header: async () => header(record(card(C2, true)))
      },
      {
        name: 'two records',
        reason: 'header',
        header: async () =>
          header(record(card(C1, true)), record(card(C1, true)))
      },
      {
        name: 'a header that is not base64url',
        reason: 'header',
        header: async () => '!!'
      }
    ];

    it.each(recordCases)(
      'refuses $name with 400 INVALID_SIGNED_RECORD ($reason), and writes nothing',
      async ({ reason, header: makeHeader, grants: makeGrants }) => {
        await seedLegacy();
        await cutAndLoad(true);
        const grants = makeGrants ? await makeGrants() : [fixture.grant];
        const before = [await rowsOf('identity', P), await rowsOf('legacy', W)];
        const result = await refusal(
          writer({ grants }).write(request(card(C1, true), await makeHeader()))
        );
        expect([result.status, result.code, result.reason]).toEqual([
          400,
          'INVALID_SIGNED_RECORD',
          reason
        ]);
        expect(result.message).toMatch(/^Invalid signed record: /);
        expect([
          await rowsOf('identity', P),
          await rowsOf('legacy', W)
        ]).toEqual(before);
        expect(await logEntries()).toEqual([]);
        expect(await heads()).toEqual([]);
      }
    );

    it('refuses an author not bound to the owner at the anchor (not-bound)', async () => {
      await seedLegacy();
      await cutAndLoad(true);
      const result = await refusal(
        writer({
          bindings: bindingSource([{ wallet: W, principal: P, from: 2000 }])
        }).write(request(card(C1, true), header(record(card(C1, true)))))
      );
      expect([result.status, result.reason]).toEqual([400, 'not-bound']);
      expect(await logEntries()).toEqual([]);
    });

    it('answers 503 BINDING_UNAVAILABLE when the binding at the anchor cannot be read, and writes nothing', async () => {
      await seedLegacy();
      await cutAndLoad(true);
      const before = [await rowsOf('identity', P), await rowsOf('legacy', W)];
      const result = await refusal(
        writer({
          bindings: {
            principalAt: async () => {
              throw new Error('gateway timed out');
            }
          }
        }).write(request(card(C1, true), header(record(card(C1, true)))))
      );
      expect([result.status, result.code]).toEqual([
        503,
        'BINDING_UNAVAILABLE'
      ]);
      expect([await rowsOf('identity', P), await rowsOf('legacy', W)]).toEqual(
        before
      );
      expect(await logEntries()).toEqual([]);
      expect(await heads()).toEqual([]);
    });

    it("refuses a record signed for another wallet than the session's (author)", async () => {
      await seedLegacy();
      await cutAndLoad(true);
      const result = await refusal(
        writer().write(
          request(card(C1, true), header(record(card(C1, true))), {
            wallet: OTHER
          })
        )
      );
      expect([result.status, result.reason]).toEqual([400, 'author']);
    });

    it("refuses a record whose owner is not the route key's identity (owner)", async () => {
      await seedLegacy();
      await execute(
        `INSERT INTO ${ADDRESS_CONSOLIDATION_KEY} (address, consolidation_key) VALUES (:o, :o)`,
        { o: OTHER }
      );
      await cutAndLoad(true);
      // A record for P, sent for OTHER's key (the route's own auth check
      // aside, the record must name the key's identity).
      const result = await refusal(
        writer().write(
          request(card(C1, true), header(record(card(C1, true))), {
            routeKey: OTHER
          })
        )
      );
      expect([result.status, result.reason]).toEqual([400, 'owner']);
    });

    it('refuses a record sent again, and an older one, as stale (409), changing nothing', async () => {
      await seedLegacy();
      await cutAndLoad(true);
      const now = Date.now();
      const newer = record(card(C1, true), { claimedTime: now });
      const older = record(card(C1, false), { claimedTime: now - 1000 });
      await writer().write(request(card(C1, true), header(newer)));
      const after = [
        await rowsOf('identity', P),
        await rowsOf('legacy', W),
        await logEntries(),
        await heads()
      ];
      for (const [change, event] of [
        [card(C1, true), newer],
        [card(C1, false), older]
      ] as const) {
        expect(
          await refusal(writer().write(request(change, header(event))))
        ).toEqual({
          status: 409,
          code: 'STALE_SIGNED_RECORD',
          reason: undefined,
          message: 'A newer change to this choice is already saved.'
        });
      }
      expect([
        await rowsOf('identity', P),
        await rowsOf('legacy', W),
        await logEntries(),
        await heads()
      ]).toEqual(after);
    });

    it.each([
      [
        'a card after the cutoff',
        card(RELEASED, true),
        'CLOSED',
        `Subscriptions are closed for Meme #${RELEASED}.`
      ],
      [
        'a count over the eligibility',
        count(C2, 3),
        'OVER_ELIGIBILITY',
        `Eligibility count for Meme #${C2} is 2. You cannot increase the subscription count beyond this limit.`
      ],
      [
        'a count beyond the balance',
        count(C2, 2),
        'BALANCE',
        `Not enough balance to subscribe for 2 editions. Need at least ${2 * 0.06529} ETH.`
      ],
      [
        'automatic mode without the balance',
        MODE_ON,
        'BALANCE',
        'Not enough balance to set Subscription to Automatic. Need at least 0.06529 ETH.'
      ]
    ])(
      'refuses %s with the route words and code, writing nothing',
      async (_name, change, code, message) => {
        await seedLegacy();
        await cutAndLoad(true);
        // A short balance on both sides for the balance cases.
        if (code === 'BALANCE') {
          await execute(
            `UPDATE ${SUBSCRIPTIONS_ID_BALANCES_TABLE} SET balance = 0.06 WHERE identity_key = :p`,
            { p: P }
          );
        }
        const before = [await rowsOf('identity', P), await rowsOf('legacy', W)];
        expect(
          await refusal(writer().write(request(change, header(record(change)))))
        ).toEqual({ status: 400, code, reason: undefined, message });
        expect([
          await rowsOf('identity', P),
          await rowsOf('legacy', W)
        ]).toEqual(before);
        expect(await logEntries()).toEqual([]);
        expect(await heads()).toEqual([]);
      }
    );

    it('leaves the identity and legacy tables holding the same rows after each kind', async () => {
      await seedLegacy();
      await cutAndLoad(true);
      expect(await rowsOf('identity', P)).toEqual(await rowsOf('legacy', W));
      const changes: SubscriptionChange[] = [
        MODE_ON,
        ALL_ON,
        card(C1, true),
        count(C1, 2),
        card(C2, false),
        { type: 'subs.mode', automatic: false },
        { type: 'subs.all-editions', all: false }
      ];
      for (const change of changes) {
        await writer().write(request(change, header(record(change))));
        expect(await rowsOf('identity', P)).toEqual(await rowsOf('legacy', W));
      }
      expect((await rowsOf('identity', P)).lines.slice(-8)).toEqual([
        ['Subscription Mode set to Automatic', null],
        ['Edition preference set to All eligible editions', null],
        [
          `Subscribed for Meme #${C1}`,
          'Edition Preference: All eligible - Eligibility: x2 - Subscription Count: x2'
        ],
        [`Updated subscription count for Meme #${C1} to x2`, 'Eligibility: x2'],
        [`Unsubscribed from Meme #${C2}`, ''],
        ['Subscription Mode set to Manual', null],
        [`Unsubscribed from Meme #${C1}`, null],
        ['Edition preference set to One edition', null]
      ]);
    });

    it('works for a bare wallet bound to no principal', async () => {
      await seedLegacy({ bound: false });
      await cutAndLoad(true);
      const unbound = bindingSource([]);
      await writer({ bindings: unbound }).write(
        request(MODE_ON, header(record(MODE_ON, { owner: W })))
      );
      expect((await rowsOf('identity', W)).mode).toEqual([[1, 0]]);
      expect(await rowsOf('identity', W)).toEqual(await rowsOf('legacy', W));
      // The wallet's records go to ps/<wallet> while it is unbound, never
      // to a principal's stream.
      const result = await refusal(
        writer({ bindings: unbound }).write(
          request(ALL_ON, header(record(ALL_ON, { owner: P })))
        )
      );
      expect([result.status, result.reason]).toEqual([400, 'not-bound']);
    });

    /** The mirror binds W to P after the opening (the fold has not run). */
    async function bindInMirror() {
      await execute(
        `INSERT INTO ${IDENTITIES_TABLE} (consolidation_key, profile_id, primary_address, tdh, rep, cic, level_raw)
          VALUES (:w, 'profile-1', :w, 0, 0, 0, 0)`,
        { w: W }
      );
      await execute(
        `INSERT INTO identity_chain_principals VALUES (:p, 'profile-1', 'LEGACY', 0)`,
        { p: P }
      );
    }

    it("writes a bare wallet's change to the wallet's own rows until the fold moves them into its identity", async () => {
      // W was its own identity at the opening. The mirror has bound it to P
      // since; at the record's anchor the chain had it bound to none, so the
      // record is W's own.
      await seedLegacy({ bound: false });
      await cutAndLoad(true);
      await bindInMirror();
      await writer({ bindings: bindingSource([]) }).write(
        request(MODE_ON, header(record(MODE_ON, { owner: W })))
      );
      expect((await rowsOf('identity', W)).mode).toEqual([[1, 0]]);
      expect((await rowsOf('identity', P)).mode).toEqual([]);
      const choice = (await logEntries())
        .map((e) => journalBodyOf(e))
        .find((body) => body?.kind === 'choice');
      expect([choice?.inputs.owner, choice?.inputs.identity_key]).toEqual([
        W,
        W
      ]);
      // The fold brings the change along.
      expect(await foldBoundWallets()).toBe(1);
      expect((await rowsOf('identity', W)).mode).toEqual([]);
      expect((await rowsOf('identity', P)).mode).toEqual([[1, 0]]);
    });

    it('after a fold of W into its identity, writes a change owned by W to the identity, and a rebuild from the journal holds', async () => {
      await seedLegacy({ bound: false });
      const opening = await cutAndLoad(true);
      await bindInMirror();
      expect(await foldBoundWallets()).toBe(1);
      await writer({ bindings: bindingSource([]) }).write(
        request(MODE_ON, header(record(MODE_ON, { owner: W })))
      );
      // W has no rows left, so the change went to P's.
      expect((await rowsOf('identity', P)).mode).toEqual([[1, 0]]);
      expect(await rowsOf('identity', W)).toEqual({
        mode: [],
        cards: [],
        lines: []
      });
      const bodies = (await logEntries())
        .map((e) => journalBodyOf(e))
        .filter((body) => body !== null);
      // The fold writer's fold, then the change's own link of W to P (the
      // opening doesn't have W in P; a repeat of a fold is a no-op), then
      // the change.
      expect(
        bodies.map((b) => [b.kind, b.rekeys, b.changes.length > 0])
      ).toEqual([
        ['fold', [{ from: W, to: P }], true],
        ['fold', [{ from: W, to: P }], false],
        ['choice', [], true]
      ]);
      const choice = bodies[2];
      expect([choice.inputs.owner, choice.inputs.identity_key]).toEqual([W, P]);
      expect(
        choice.changes.map((c) => [c.table, c.key.identity_key])
      ).toContainEqual(['mode', P]);
      const tablesBefore = await identityTablesHash({});
      const headsBefore = await heads();
      for (const table of [
        ...IDENTITY_DATA_TABLES,
        SUBSCRIPTIONS_ID_STATE_TABLE,
        SUBSCRIPTIONS_ID_CURSORS_TABLE,
        SIGNED_RECORD_HEADS_TABLE
      ]) {
        await execute(`DELETE FROM ${table}`);
      }
      subscriptionsIdentitySwitch.invalidate();
      const result = await rebuildIdentityTables({
        source: journalSource,
        opening
      });
      expect(result).toEqual(
        expect.objectContaining({ entries: 3, skipped: 0, missing: null })
      );
      expect(await identityTablesHash({})).toBe(tablesBefore);
      expect(await heads()).toEqual(headsBefore);
    });

    it('links a wallet with no rows of its own to the identity its change goes to, with an empty fold first', async () => {
      // W has nothing at the opening, binds to P after the record's anchor,
      // and its change goes to P's rows. Nothing else in the journal would
      // tie W to P.
      await seedLegacy({ bound: false });
      for (const table of [
        SUBSCRIPTIONS_BALANCES_TABLE,
        SUBSCRIPTIONS_NFTS_TABLE,
        SUBSCRIPTIONS_TOP_UP_TABLE
      ]) {
        await execute(`DELETE FROM ${table}`);
      }
      const opening = await cutAndLoad(true);
      await bindInMirror();
      await writer({ bindings: bindingSource([]) }).write(
        request(ALL_ON, header(record(ALL_ON, { owner: W })))
      );
      expect((await rowsOf('identity', P)).mode).toEqual([[0, 1]]);
      const bodies = (await logEntries())
        .map((e) => journalBodyOf(e))
        .filter((body) => body !== null);
      expect(
        bodies.map((b) => [b.kind, b.inputs, b.rekeys, b.changes.length])
      ).toEqual([
        [
          'fold',
          { wallet: W, identity_key: P, at_text: expect.any(String) },
          [{ from: W, to: P }],
          0
        ],
        [
          'choice',
          expect.objectContaining({ owner: W, identity_key: P }),
          [],
          2
        ]
      ]);
      expect(bodies[1].n).toBe(bodies[0].n + 1);
      const tablesBefore = await identityTablesHash({});
      for (const table of [
        ...IDENTITY_DATA_TABLES,
        SUBSCRIPTIONS_ID_STATE_TABLE,
        SUBSCRIPTIONS_ID_CURSORS_TABLE
      ]) {
        await execute(`DELETE FROM ${table}`);
      }
      subscriptionsIdentitySwitch.invalidate();
      const result = await rebuildIdentityTables({
        source: journalSource,
        opening
      });
      expect(result).toEqual(
        expect.objectContaining({ entries: 2, skipped: 0, missing: null })
      );
      expect(await identityTablesHash({})).toBe(tablesBefore);
    });

    /** Which identity each history row (log, top-up, final, redeemed) is under. */
    async function historyKeys(): Promise<Record<string, string[]>> {
      const keys: Record<string, string[]> = {};
      for (const table of [
        SUBSCRIPTIONS_ID_LOGS_TABLE,
        SUBSCRIPTIONS_ID_TOP_UP_TABLE,
        SUBSCRIPTIONS_ID_NFTS_FINAL_TABLE,
        SUBSCRIPTIONS_ID_REDEEMED_TABLE
      ]) {
        keys[table] = (
          await sqlExecutor.execute<{ identity_key: string }>(
            `SELECT identity_key FROM ${table} ORDER BY identity_key`
          )
        ).map((row) => row.identity_key);
      }
      return keys;
    }

    it.each([
      ['a log line', 'logs'],
      ['a top-up', 'top-up']
    ])(
      'moves the history of a wallet with only %s to the identity when it links them, as a rebuild does',
      async (_name, kept) => {
        await seedLegacy({ bound: false });
        for (const table of [
          SUBSCRIPTIONS_BALANCES_TABLE,
          SUBSCRIPTIONS_NFTS_TABLE
        ]) {
          await execute(`DELETE FROM ${table}`);
        }
        if (kept === 'logs') {
          await execute(`DELETE FROM ${SUBSCRIPTIONS_TOP_UP_TABLE}`);
          await execute(
            `INSERT INTO ${SUBSCRIPTIONS_LOGS_TABLE} (consolidation_key, log) VALUES (:w, 'A line from before the cut')`,
            { w: W }
          );
        }
        const opening = await cutAndLoad(true);
        const table =
          kept === 'logs'
            ? SUBSCRIPTIONS_ID_LOGS_TABLE
            : SUBSCRIPTIONS_ID_TOP_UP_TABLE;
        expect((await historyKeys())[table]).toEqual([W]);
        await bindInMirror();
        await writer({ bindings: bindingSource([]) }).write(
          request(ALL_ON, header(record(ALL_ON, { owner: W })))
        );
        const live = await historyKeys();
        expect(live[table]).not.toContain(W);
        expect(live[table]).toContain(P);
        const tablesBefore = await identityTablesHash({});
        for (const data of [
          ...IDENTITY_DATA_TABLES,
          SUBSCRIPTIONS_ID_STATE_TABLE,
          SUBSCRIPTIONS_ID_CURSORS_TABLE,
          SIGNED_RECORD_HEADS_TABLE
        ]) {
          await execute(`DELETE FROM ${data}`);
        }
        subscriptionsIdentitySwitch.invalidate();
        const result = await rebuildIdentityTables({
          source: journalSource,
          opening
        });
        expect(result).toEqual(
          expect.objectContaining({ skipped: 0, missing: null })
        );
        expect(await historyKeys()).toEqual(live);
        expect(await identityTablesHash({})).toBe(tablesBefore);
      }
    );

    it('journals no link for a wallet the opening already has in the identity', async () => {
      await seedLegacy();
      await cutAndLoad(true);
      await writer({ bindings: bindingSource([]) }).write(
        request(ALL_ON, header(record(ALL_ON, { owner: W })))
      );
      const bodies = (await logEntries())
        .map((e) => journalBodyOf(e))
        .filter((body) => body !== null);
      expect(bodies.map((b) => [b.kind, b.inputs.identity_key])).toEqual([
        ['choice', P]
      ]);
    });

    it("takes a principal route key from a wallet of that identity, and refuses anyone else's", async () => {
      await seedLegacy();
      await execute(
        `INSERT INTO ${ADDRESS_CONSOLIDATION_KEY} (address, consolidation_key) VALUES (:o, :o)`,
        { o: OTHER }
      );
      await cutAndLoad(true);
      // The route's own check fails for a principal key (no legacy rows).
      const asPrincipal = (wallet: string) =>
        request(MODE_ON, header(record(MODE_ON)), {
          routeKey: P,
          wallet,
          walletInKey: false
        });
      expect(await writer().write(asPrincipal(W))).toEqual({
        consolidation_key: P,
        automatic: true
      });
      expect((await rowsOf('identity', P)).mode).toEqual([[1, 0]]);
      // The dual write goes to the identity's consolidation key.
      expect((await rowsOf('legacy', W)).mode).toEqual([[1, 0]]);
      expect(await refusal(writer().write(asPrincipal(OTHER)))).toEqual(
        expect.objectContaining({ status: 403 })
      );
    });

    it('rolls the whole change back when the cutoff passes while it is written', async () => {
      await seedLegacy();
      await cutAndLoad(true);
      const before = [await rowsOf('identity', P), await rowsOf('legacy', W)];
      // Open when the change is worked out; closed by the re-check after
      // the write, in the same transaction.
      const cutoff = jest
        .spyOn(cutoffModule, 'getSubscriptionCutoffMemeId')
        .mockResolvedValueOnce(RELEASED)
        .mockResolvedValueOnce(C1);
      try {
        expect(
          await refusal(
            writer().write(
              request(card(C1, true), header(record(card(C1, true))))
            )
          )
        ).toEqual({
          status: 400,
          code: 'CLOSED',
          reason: undefined,
          message: `Subscriptions are closed for Meme #${C1}.`
        });
        expect(cutoff).toHaveBeenCalledTimes(2);
      } finally {
        cutoff.mockRestore();
      }
      expect([await rowsOf('identity', P), await rowsOf('legacy', W)]).toEqual(
        before
      );
      expect(await logEntries()).toEqual([]);
      expect(await heads()).toEqual([]);
    });

    it('rebuilds the identity tables from the opening and the journal alone, giving the same API answers', async () => {
      await seedLegacy();
      const opening = await cutAndLoad(true);
      const now = Date.now();
      // Two unsubscribed cards that automatic mode turns back on together,
      // and manual mode turns off together again.
      const changes: SubscriptionChange[] = [
        card(C1, false),
        card(C3, false),
        MODE_ON,
        ALL_ON,
        count(C1, 2),
        card(C2, false),
        { type: 'subs.mode', automatic: false },
        card(C1, true)
      ];
      let at = now - changes.length * 1000;
      for (const change of changes) {
        await writer().write(
          request(change, header(record(change, { claimedTime: at })))
        );
        at += 1000;
      }
      // A refused change leaves nothing in the log.
      await refusal(
        writer().write(request(count(C1, 3), header(record(count(C1, 3)))))
      );
      const answers = async () => {
        const out: Record<string, unknown> = {};
        for (const key of [W, P]) {
          out[key] = {
            details: await fetchDetailsForConsolidationKey(key),
            upcoming: await fetchUpcomingMemeSubscriptions(key, 4),
            status: [
              await fetchUpcomingMemeSubscriptionStatusForConsolidationKey(
                key,
                C1
              ),
              await fetchUpcomingMemeSubscriptionStatusForConsolidationKey(
                key,
                C2
              )
            ],
            logs: (await fetchLogsForConsolidationKey(key, 100, 1)).data
          };
        }
        return out;
      };
      const before = await answers();
      const tablesBefore = await identityTablesHash({});
      const headsBefore = await heads();
      // One per choice: the mode, all editions, C1's count, and the C1, C2
      // and C3 subscriptions.
      expect(headsBefore).toHaveLength(6);

      // The log holds each change's signed event, then its journal entry.
      const entries = (await logEntries()).filter((e) => e.lane === 'subs');
      expect(
        entries.map((e) => (e.t === 'event' ? 'event' : journalBodyOf(e)?.kind))
      ).toEqual(changes.flatMap(() => ['event', 'choice']));
      // Every mode and choice row a change touched was read before it
      // wrote, so the rebuild checks it.
      const touched = entries
        .map((e) => journalBodyOf(e))
        .flatMap((body) => body?.changes ?? [])
        .filter((c) => c.table === 'mode' || c.table === 'choices');
      expect(touched.every((c) => c.before !== undefined)).toBe(true);
      // Each mode change flipped both unsubscribed cards in one entry.
      const flips = entries
        .map((e) => journalBodyOf(e))
        .filter((body) => body?.inputs.type === 'subs.mode')
        .map((body) =>
          body!.changes
            .filter((c) => c.table === 'choices')
            .map((c) => [
              Number(c.key.token_id),
              Number(c.before?.subscribed),
              Number(c.after?.subscribed)
            ])
        );
      expect(flips).toEqual([
        [
          [C1, 0, 1],
          [C3, 0, 1]
        ],
        [
          [C1, 1, 0],
          [C3, 1, 0]
        ]
      ]);
      // Each event verifies against the grant proof it carries: no grant
      // table and no live window.
      for (const entry of entries) {
        if (entry.t === 'event') {
          const verified = await verifyRecordEvent(entry.event, {
            grants: new GrantProofRecordSource([entry.grant]),
            bindings: bindingSource([{ wallet: W, principal: P, from: 1 }])
          });
          expect(verified.ok).toBe(true);
        }
      }

      // Lose every identity table, its state and cursors, and the record
      // heads; rebuild from the opening files and the journal.
      for (const table of [
        ...IDENTITY_DATA_TABLES,
        SUBSCRIPTIONS_ID_STATE_TABLE,
        SUBSCRIPTIONS_ID_CURSORS_TABLE,
        SIGNED_RECORD_HEADS_TABLE
      ]) {
        await execute(`DELETE FROM ${table}`);
      }
      subscriptionsIdentitySwitch.invalidate();
      const result = await rebuildIdentityTables({
        source: journalSource,
        opening
      });
      expect(result).toEqual(
        expect.objectContaining({
          entries: changes.length,
          skipped: 0,
          missing: null
        })
      );
      expect(await identityTablesHash({})).toBe(tablesBefore);
      // The heads are back, so an older record is still refused as stale.
      expect(await heads()).toEqual(headsBefore);
      // The rebuild leaves the tables verified and in shadow; switch to them
      // to read the API's answers.
      expect(
        await scheduleIdentitySwitch(Date.now(), opening.openingSha256)
      ).toBe(true);
      subscriptionsIdentitySwitch.invalidate();
      expect(await answers()).toEqual(before);
      const older = record(card(C1, false), { claimedTime: now - 60_000 });
      expect(
        await refusal(writer().write(request(card(C1, false), header(older))))
      ).toEqual(
        expect.objectContaining({ status: 409, code: 'STALE_SIGNED_RECORD' })
      );
    });
  });

  it('pauses every change while go-live runs (503), with or without a record', async () => {
    await seedLegacy();
    await cutAndLoad(false);
    await closeSubscriptionWrites();
    for (const signed of [undefined, header(record(card(C1, true)))]) {
      expect(
        await refusal(
          writer({ shadow: true }).write(request(card(C1, true), signed))
        )
      ).toEqual({
        status: 503,
        code: undefined,
        reason: undefined,
        message:
          'Subscription changes are paused for a few minutes. Try again shortly.'
      });
    }
    expect(await logEntries()).toEqual([]);
  });

  it("LEGACY: makes today's write and ignores the header", async () => {
    await seedLegacy();
    await cutAndLoad(false);
    const identityBefore = await rowsOf('identity', P);
    for (const signed of ['!!', header(record(card(C1, true)))]) {
      expect(await writer().write(request(card(C1, true), signed))).toEqual({
        consolidation_key: W,
        contract: MEMES_CONTRACT,
        token_id: C1,
        subscribed: true,
        subscribed_count: 1
      });
    }
    expect((await rowsOf('legacy', W)).cards).toContainEqual([C1, 1, 1, 0]);
    expect(await rowsOf('identity', P)).toEqual(identityBefore);
    expect(await logEntries()).toEqual([]);
    expect(await reports()).toEqual([]);
  });

  describe('before the switch (SHADOW)', () => {
    it('writes both sides from a valid record and reports a MATCH', async () => {
      await seedLegacy();
      await cutAndLoad(false);
      for (const change of [MODE_ON, card(C1, true), count(C1, 2)]) {
        await writer({ shadow: true }).write(
          request(change, header(record(change)))
        );
      }
      expect(await rowsOf('identity', P)).toEqual(await rowsOf('legacy', W));
      expect(
        (await reports()).map((r) => [r.kind, r.mode, r.verdict, r.token_id])
      ).toEqual([
        ['RECORD', 'SHADOW', 'MATCH', null],
        ['RECORD', 'SHADOW', 'MATCH', C1],
        ['RECORD', 'SHADOW', 'MATCH', C1]
      ]);
      // Each signed event goes to lane subs; its journal entry, made before
      // the switch, to subs-shadow.
      expect(
        (await logEntries()).map((e) => [
          e.lane,
          e.t === 'event' ? 'event' : journalBodyOf(e)?.kind,
          e.t === 'event' ? null : journalBodyOf(e)?.mode
        ])
      ).toEqual(
        [1, 2, 3].flatMap(() => [
          ['subs', 'event', null],
          ['subs-shadow', 'choice', 'shadow']
        ])
      );
    });

    it("keeps today's write and reports it REFUSED when the record does not verify", async () => {
      await seedLegacy();
      await cutAndLoad(false);
      const event = record(card(C1, true));
      const bad = { ...event, body_hash: `0x${'0'.repeat(64)}` };
      const identityBefore = await rowsOf('identity', P);
      await writer({ shadow: true }).write(
        request(card(C1, true), header(bad))
      );
      expect((await rowsOf('legacy', W)).cards).toContainEqual([C1, 1, 1, 0]);
      expect(await rowsOf('identity', P)).toEqual(identityBefore);
      const [report] = await reports();
      expect([report.kind, report.verdict, report.token_id]).toEqual([
        'RECORD',
        'REFUSED',
        C1
      ]);
      expect(report.report.notes).toEqual([
        'subs.card no event id',
        'invalid-record:body'
      ]);
      // No record contents in the report.
      expect(JSON.stringify(report.report)).not.toContain(event.signature);
      expect(await logEntries()).toEqual([]);
    });

    it("keeps today's write and reports it REFUSED, not counted, when the key's wallets span identities mid re-key", async () => {
      await seedLegacy();
      await cutAndLoad(false);
      // A legacy key of W and a wallet bound to no principal: the mirror
      // has its wallets in two identities until the re-key catches up.
      const spanning = `${W}-${OTHER}`;
      await execute(
        `INSERT INTO ${SUBSCRIPTIONS_BALANCES_TABLE} (consolidation_key, balance) VALUES (:k, 0.5)`,
        { k: spanning }
      );
      const identityBefore = await rowsOf('identity', P);
      await writer({ shadow: true }).write({
        ...request(MODE_ON, header(record(MODE_ON))),
        routeKey: spanning
      });
      expect(
        (await rowsOf('legacy', spanning)).mode.map(([automatic]) => automatic)
      ).toEqual([1]);
      expect(await rowsOf('identity', P)).toEqual(identityBefore);
      const [report] = await reports();
      expect([report.kind, report.verdict]).toEqual(['RECORD', 'REFUSED']);
      expect(report.report.notes[1]).toBe('refused:KEY_SPANS_IDENTITIES');
    });

    it("reports a DIFF when the identity side refuses what today's write took", async () => {
      await seedLegacy();
      await cutAndLoad(false);
      await execute(
        `UPDATE ${SUBSCRIPTIONS_ID_BALANCES_TABLE} SET balance = 0.01 WHERE identity_key = :p`,
        { p: P }
      );
      await writer({ shadow: true }).write(
        request(card(C1, true), header(record(card(C1, true))))
      );
      expect((await rowsOf('legacy', W)).cards).toContainEqual([C1, 1, 1, 0]);
      const [report] = await reports();
      expect(report.verdict).toBe('DIFF');
      expect(report.report.notes[1]).toBe('rule:BALANCE');
    });

    it("lets the go-live gate skip records refused in shadow, and count the identity side's rule refusals", async () => {
      await seedLegacy();
      await cutAndLoad(false);
      const CARD = 579;
      const gateReport = (kind: string, verdict: string) =>
        execute(
          `INSERT INTO ${SUBSCRIPTIONS_ID_REPORTS_TABLE} (kind, mode, token_id, verdict, report, created_at)
            VALUES (:kind, 'SHADOW', :card, :verdict, '{}', 0)`,
          { kind, card: CARD, verdict }
        );
      await gateReport('LIST', 'MATCH');
      // Four records the identity side never took: a bad signature, the same
      // record sent twice (stale), one sent while the anchor was down, and
      // one whose author's binding could not be read.
      const event = record(card(C1, true));
      await writer({ shadow: true }).write(
        request(
          card(C1, true),
          header({ ...event, signature: `0x${'1'.repeat(128)}` })
        )
      );
      await writer({ shadow: true }).write(
        request(card(C1, true), header(event))
      );
      await writer({ shadow: true }).write(
        request(card(C1, true), header(event))
      );
      await writer({
        shadow: true,
        anchors: {
          getAnchor: async () => {
            throw new CustomApiCompliantException(
              503,
              'The chain gateway did not answer, so there is no anchor height',
              'ANCHOR_UNAVAILABLE'
            );
          }
        }
      }).write(request(card(C2, false), header(record(card(C2, false)))));
      await writer({
        shadow: true,
        bindings: {
          principalAt: async () => {
            throw new Error('gateway timed out');
          }
        }
      }).write(request(card(C2, true), header(record(card(C2, true)))));
      await gateReport('PHASE', 'MATCH');
      await gateReport('REDEMPTIONS', 'MATCH');
      expect(
        (await reports())
          .filter((r) => r.kind === 'RECORD')
          .map((r) => [r.verdict, r.report.notes[1] ?? null])
      ).toEqual([
        ['REFUSED', 'invalid-record:sig'],
        ['MATCH', null],
        ['REFUSED', 'refused:STALE_SIGNED_RECORD'],
        ['REFUSED', 'refused:ANCHOR_UNAVAILABLE'],
        ['REFUSED', 'refused:BINDING_UNAVAILABLE']
      ]);
      // Refusals are not differences. (The share of refusals and the
      // matches the switch needs have their own tests; here they are off.)
      const counts = { minMatches: 1, maxRefusedPercent: 100 };
      const passing = await shadowReportsMatch(CARD, counts);
      expect(passing.problems).toEqual([]);
      expect(passing.ok).toBe(true);
      expect(passing.checked).toContain(
        '4 signed records refused in shadow (not counted)'
      );
      // The identity side refusing what today's write took is counted.
      await execute(
        `UPDATE ${SUBSCRIPTIONS_ID_BALANCES_TABLE} SET balance = 0.01 WHERE identity_key = :p`,
        { p: P }
      );
      await writer({ shadow: true }).write(
        request(card(C3, true), header(record(card(C3, true))))
      );
      const failing = await shadowReportsMatch(CARD, counts);
      expect(failing.ok).toBe(false);
      expect(failing.problems).toHaveLength(1);
      expect(failing.problems[0]).toMatch(/^RECORD comparison \d+ /);
      expect(failing.problems[0]).toContain(`(card ${C3}) is a DIFF`);
    });

    it('reports which rows differ, without their values, when the sides had drifted', async () => {
      await seedLegacy();
      await cutAndLoad(false);
      // Unsigned changes earlier reached only the legacy tables.
      await writer({ shadow: true }).write(request(card(C1, true), undefined));
      await writer({ shadow: true }).write(request(count(C2, 2), undefined));
      expect(await reports()).toEqual([]);
      await writer({ shadow: true }).write(
        request(ALL_ON, header(record(ALL_ON)))
      );
      const [report] = await reports();
      expect(report.verdict).toBe('DIFF');
      expect(report.report.diffs).toEqual([
        { key: `card ${C1}`, legacy: 'row', identity: null },
        { key: `card ${C2} subscribed_count`, legacy: null, identity: null }
      ]);
      // A mode change that each side flips differently adds other lines.
      await writer({ shadow: true }).write(request(card(C2, false), undefined));
      await writer({ shadow: true }).write(
        request(MODE_ON, header(record(MODE_ON)))
      );
      const modeReport = (await reports())[1];
      expect(modeReport.report.diffs).toEqual(
        expect.arrayContaining([
          { key: 'log lines', legacy: '2', identity: '1' }
        ])
      );
    });
  });
});
