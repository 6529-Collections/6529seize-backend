import { MembershipRefreshTargetsDb } from './membership-refresh-targets.db';
import { randomUUID } from 'node:crypto';
import { MembershipRuntimeTransportDb } from './membership-runtime-transport.db';
import { MembershipRuntimeSendFaultDb } from './membership-runtime-send-fault.db';
import { MembershipDispatchDb } from './membership-dispatch.db';
import * as schemaExecution from '@/dbMigrationsLoop/membership-additive-schema';
import { performance } from 'node:perf_hooks';
import {
  MEMBERSHIP_FIXTURE_GROUPS,
  MEMBERSHIP_FIXTURE_PROFILES
} from './membership-runtime-policy';
import {
  MEMBERSHIP_FIXTURE_MANIFEST_HASH,
  MEMBERSHIP_FIXTURE_SOURCE_KEYS
} from './membership-runtime-fixture-manifest';
import { prepareMembershipFixtureSchema } from './membership-runtime-fixture-setup-schema';
import { MembershipFixtureControlDb } from './membership-runtime-fixture-control';
import { MEMBERSHIP_FIXTURE_CLEANUP_TABLES } from './membership-runtime-fixture-control-layout';
import { MembershipSourceStatesDb } from './membership-source-states.db';
import { MembershipRefreshWorker } from './membership-worker';
import { PrimaryMembershipProfileEvaluator } from './membership-profile-evaluator';
import { membershipTestOptions } from './membership-worker-test.helpers';
import {
  MEMBERSHIP_GENERATION_MEMBERS_TABLE,
  IDENTITIES_TABLE,
  MEMBERSHIP_PUBLICATIONS_TABLE,
  MEMBERSHIP_REFRESH_RUNS_TABLE
} from '@/constants';
import {
  createMembershipFixtureTestHarness,
  MembershipFixtureTestHarness,
  membershipFixtureTestEnvironment as environment
} from './membership-runtime-fixture-test.helpers';
jest.setTimeout(600000);
let harness: MembershipFixtureTestHarness;
let db: MembershipFixtureTestHarness['db'];
let source: MembershipFixtureTestHarness['source'];
let service: MembershipFixtureTestHarness['service'];
let tx: MembershipFixtureTestHarness['tx'];
let schema: MembershipFixtureTestHarness['schema'];
let prepare: MembershipFixtureTestHarness['prepare'];
beforeEach(async () => {
  harness = await createMembershipFixtureTestHarness();
  ({ db, source, service, tx, schema, prepare } = harness);
});
afterEach(async () => {
  jest.restoreAllMocks();
  if (harness) await harness.close();
});
describe('closed staging fixture actual MySQL setup', () => {
  it('resumes bounded create-only schema and proves real source jobs/catalogue versions before18-page runs', async () => {
    const first = await prepareMembershipFixtureSchema(source, environment);
    expect(first).toMatchObject({ ready: false, created_tables: 4 });
    await schema();
    expect(
      await prepareMembershipFixtureSchema(source, environment)
    ).toMatchObject({ ready: true, created_tables: 0, verified_tables: 21 });
    let control = await tx((ctx) => service.prepare(ctx));
    expect(control.state.setup_stage).toBe('SCHEMA_READY');
    control = await tx((ctx) => service.prepare(ctx));
    expect(control.state.setup_stage).toBe('PROVISIONED');
    const barriers = await tx((ctx) =>
      new MembershipSourceStatesDb(() => db).read(
        MEMBERSHIP_FIXTURE_SOURCE_KEYS,
        false,
        ctx
      )
    );
    expect(
      barriers.filter(({ state }) => state?.active_jobs === 1)
    ).toHaveLength(24);
    for (let n = 0; n < 3; n++) await tx((ctx) => service.prepare(ctx));
    expect((await tx((ctx) => service.prepare(ctx))).state.setup_stage).toBe(
      'CATALOGUED'
    );
    const ready = await tx((ctx) => service.prepare(ctx));
    expect(ready.state.setup_stage).toBe('READY');
    expect(await tx((ctx) => service.prepare(ctx))).toEqual(ready);
    const status = await tx((ctx) => service.status(ctx));
    expect(status.candidates).toHaveLength(36);
    expect(
      status.candidates.every((row) => Number(row.is_pure_profile_group) === 0)
    ).toBe(true);
    expect(
      status.sources.every((row) => row.provisioned && row.active_jobs === 0)
    ).toBe(true);
    expect(
      status.sources.every(
        (row) => row.version === (row.dimension === 'GROUP_CATALOG' ? '1' : '2')
      )
    ).toBe(true);
    expect(status.jobs).toHaveLength(24);
    expect(
      status.jobs.every(
        (row) => row.status === 'COMPLETED' && row.stage === 'STATS_ACTIVATED'
      )
    ).toBe(true);
    const worker = new MembershipRefreshWorker(
      db,
      new PrimaryMembershipProfileEvaluator(() => db)
    );
    let fanoutComplete = false;
    for (let n = 0; n < 6; n++) {
      const result = await worker.runTarget(
        { scope: 'FULL', target_id: '*' },
        membershipTestOptions({ page_size: 1 })
      );
      if (result.outcome === 'COMPLETED') {
        fanoutComplete = true;
        break;
      }
      expect(result.outcome).toBe('PENDING');
    }
    expect(fanoutComplete).toBe(true);
    expect(
      (await tx((ctx) => service.status(ctx))).targets.filter(
        (row) => row.scope === 'PROFILE'
      )
    ).toHaveLength(3);
    for (const profile of MEMBERSHIP_FIXTURE_PROFILES) {
      let invocationCount = 0;
      let run: string | null = null;
      for (; invocationCount < 25; invocationCount++) {
        const result = await worker.runTarget(
          { scope: 'PROFILE', target_id: profile },
          membershipTestOptions({
            transaction_millis: 15000,
            lease_millis: 30000,
            max_statement_millis: 3000,
            deadline_monotonic_millis: performance.now() + 30000
          })
        );
        if (run) expect(result.run_id).toBe(run);
        else run = result.run_id;
        if (result.outcome === 'COMPLETED') break;
        expect(result.outcome).toBe('PENDING');
      }
      expect(invocationCount + 1).toBeGreaterThanOrEqual(19);
      expect(invocationCount).toBeLessThan(25);
      const rows = await db.execute<{ group_id: string }>(
        `SELECT m.group_id FROM ${MEMBERSHIP_GENERATION_MEMBERS_TABLE} m JOIN ${MEMBERSHIP_PUBLICATIONS_TABLE} p ON p.run_id=m.run_id AND p.profile_id=m.profile_id WHERE p.profile_id=:profile ORDER BY m.group_id`,
        { profile }
      );
      const expected =
        profile === MEMBERSHIP_FIXTURE_PROFILES[0]
          ? [
              ...MEMBERSHIP_FIXTURE_GROUPS.slice(1, 24),
              ...[26, 27, 28, 29, 30].map((n) => MEMBERSHIP_FIXTURE_GROUPS[n])
            ]
          : profile === MEMBERSHIP_FIXTURE_PROFILES[1]
            ? [
                ...MEMBERSHIP_FIXTURE_GROUPS.slice(1, 25),
                ...[26, 29, 30, 35].map((n) => MEMBERSHIP_FIXTURE_GROUPS[n])
              ]
            : [];
      expect(rows.map((row) => row.group_id)).toEqual(expected);
      const horizon = await db.execute<{ horizon: string }>(
        `SELECT CAST(r.valid_until_millis AS CHAR) horizon FROM ${MEMBERSHIP_PUBLICATIONS_TABLE} p JOIN ${MEMBERSHIP_REFRESH_RUNS_TABLE} r ON r.id=p.run_id WHERE p.profile_id=:profile`,
        { profile }
      );
      expect(horizon).toEqual([
        { horizon: String(BigInt(ready.state.anchor_millis) + BigInt(7200000)) }
      ]);
    }
  }, 60000);
  it('proves source supersession, a captured horizon, durable retries and recovery beyond a fixed fanout high bound', async () => {
    await schema();
    await prepare();
    await expect(tx((ctx) => service.advance(ctx))).rejects.toThrow(
      'no settled current publication'
    );
    const profile = MEMBERSHIP_FIXTURE_PROFILES[0];
    const target = { scope: 'PROFILE' as const, target_id: profile };
    const worker = new MembershipRefreshWorker(
      db,
      new PrimaryMembershipProfileEvaluator(() => db)
    );
    await tx((ctx) =>
      new MembershipRefreshTargetsDb(() => db).request(
        [{ ...target, reason: 'fixture-advance-proof' }],
        ctx
      )
    );
    const finish = async (
      key: { scope: 'PROFILE' | 'FULL'; target_id: string } = target
    ) => {
      // A valid older generation may publish with a newer request still due.
      // Drive that newer generation too; COMPLETED alone does not mean settled.
      for (let n = 0; n < 60; n++) {
        const result = await worker.runTarget(
          key,
          membershipTestOptions({ page_size: key.scope === 'FULL' ? 1 : 2 })
        );
        if (result.outcome === 'COMPLETED') {
          const target = await tx((ctx) =>
            new MembershipRefreshTargetsDb(() => db).find(key, ctx)
          );
          if (
            target?.active_run_id === null &&
            target.requested_version === target.completed_version
          )
            return result;
        }
      }
      throw new Error('Fixture profile failed to finish');
    };
    const initial = await finish();
    const missed = await tx((ctx) => service.advance(ctx));
    expect(missed.state.scenario).toBe('MISSED_WAKEUP');
    await expect(tx((ctx) => service.advance(ctx))).rejects.toThrow(
      'active partial run'
    );
    // Real committed dispatch reservation and durable fixed send-fault receipt.
    // The separate dispatcher suite proves the callback rejects the actual send.
    const reservation = await tx((ctx) =>
      new MembershipDispatchDb(() => db).reserve(target, 120000, undefined, ctx)
    );
    if (reservation.outcome !== 'RESERVED')
      throw new Error('Fixture dispatch was not reserved');
    expect(
      await tx((ctx) =>
        new MembershipRuntimeSendFaultDb(db).recordOnce(reservation.hint, ctx)
      )
    ).toBe(true);
    expect(
      (await worker.runTarget(target, membershipTestOptions())).outcome
    ).toBe('NO_WORK');
    await harness.setMysqlTime(
      String(
        BigInt(reservation.hint.delivery.reserved_until_millis) + BigInt(1000)
      )
    );
    const partial = await worker.runTarget(target, membershipTestOptions());
    expect(partial.outcome).toBe('PENDING');
    expect((await tx((ctx) => service.advance(ctx))).state.scenario).toBe(
      'SOURCE_CHANGE'
    );
    expect(
      await db.execute(
        `SELECT run_id FROM ${MEMBERSHIP_PUBLICATIONS_TABLE} WHERE profile_id=:profile`,
        { profile }
      )
    ).toEqual([{ run_id: initial.run_id }]);
    await worker.runTarget(target, membershipTestOptions());
    expect(
      await db.execute(
        `SELECT status FROM ${MEMBERSHIP_REFRESH_RUNS_TABLE} WHERE id=:id`,
        { id: partial.run_id }
      )
    ).toEqual([{ status: 'SUPERSEDED' }]);
    const sourceProof = await tx((ctx) => service.advance(ctx));
    expect(sourceProof.state.scenario).toBe('SOURCE_CHANGE');
    expect(
      sourceProof.state.proof?.source_change?.superseded_observed_at_millis
    ).not.toBeNull();
    await finish();
    const armed = await tx((ctx) => service.advance(ctx));
    expect(armed.state.scenario).toBe('EXPIRY_WAIT');
    const armedGrant = await db.execute<{ boundary_offset: string }>(
      "SELECT CAST(valid_from-updated_at AS CHAR) boundary_offset FROM xtdh_grants WHERE id='membership-drill-pending-v1'"
    );
    expect(armedGrant).toEqual([{ boundary_offset: '300000' }]);
    await expect(tx((ctx) => service.advance(ctx))).rejects.toThrow(
      'active partial run'
    );
    await tx((ctx) =>
      new MembershipRefreshTargetsDb(() => db).request(
        [{ ...target, reason: 'fixture-capture-horizon' }],
        ctx
      )
    );
    const horizonPage = await worker.runTarget(target, membershipTestOptions());
    const captured = await tx((ctx) => service.advance(ctx));
    expect(captured.state.scenario).toBe('BOUNDARY_CAPTURED');
    expect(captured.state.proof?.boundary?.captured).toMatchObject({
      run_id: horizonPage.run_id,
      checkpoint_version: '1',
      valid_until_millis: captured.state.proof?.boundary?.boundary_millis
    });
    await expect(tx((ctx) => service.advance(ctx))).rejects.toThrow(
      'boundary has not arrived'
    );
    const evidence = await tx((ctx) =>
      new MembershipSourceStatesDb(() => db).read(
        MEMBERSHIP_FIXTURE_SOURCE_KEYS,
        false,
        ctx
      )
    );
    expect(
      evidence.find(
        ({ key }) =>
          key.scope === 'PROFILE' &&
          key.target_id === profile &&
          key.dimension === 'TDH_XTDH'
      )?.state?.version
    ).toBe('3');
    expect(
      evidence.find(
        ({ key }) => key.scope === 'GLOBAL' && key.dimension === 'TDH_XTDH'
      )?.state?.version
    ).toBe('2');
    const date = await db.execute<{ valid_from: string }>(
      "SELECT CAST(valid_from AS CHAR) valid_from FROM xtdh_grants WHERE id='membership-drill-pending-v1'"
    );
    await harness.setMysqlTime(
      String(BigInt(date[0].valid_from) + BigInt(1000))
    );
    await expect(tx((ctx) => service.advance(ctx))).rejects.toThrow(
      'observed horizon expiry supersession'
    );
    expect(
      (await worker.runTarget(target, membershipTestOptions())).outcome
    ).toBe('SUPERSEDED');
    const superseded = await tx((ctx) => service.advance(ctx));
    expect(
      superseded.state.proof?.boundary?.captured?.superseded_observed_at_millis
    ).not.toBeNull();
    const requestAndFinish = async () => {
      await tx((ctx) =>
        new MembershipRefreshTargetsDb(() => db).request(
          [{ ...target, reason: 'fixture-clock-boundary' }],
          ctx
        )
      );
      return finish();
    };
    await requestAndFinish();
    const granted = await tx((ctx) => service.advance(ctx));
    expect(granted.state.scenario).toBe('GRANT_ACTIVE');
    await requestAndFinish();
    expect((await tx((ctx) => service.advance(ctx))).state.scenario).toBe(
      'GRANT_DISABLED'
    );
    await requestAndFinish();
    expect((await tx((ctx) => service.advance(ctx))).state.scenario).toBe(
      'EMPTY'
    );
    // Settle the actual FULL children, then create/correct the transport receipt
    // on a real first page before the fixed identity failure scenario begins.
    const full = { scope: 'FULL' as const, target_id: '*' };
    await finish(full);
    const transportTarget = {
      scope: 'PROFILE' as const,
      target_id: MEMBERSHIP_FIXTURE_PROFILES[1]
    };
    const transportPage = await worker.runTarget(
      transportTarget,
      membershipTestOptions()
    );
    await tx((ctx) =>
      new MembershipRuntimeTransportDb(db).inspectDelivery(
        transportTarget,
        randomUUID(),
        transportPage,
        ctx
      )
    );
    expect(
      (await tx((ctx) => service.advance(ctx))).state.transport?.phase
    ).toBe('CORRECTED');
    for (const target_id of MEMBERSHIP_FIXTURE_PROFILES)
      await finish({ scope: 'PROFILE', target_id });
    const missing = await tx((ctx) => service.advance(ctx));
    expect(missing.state.scenario).toBe('IDENTITY_MISSING');
    expect(
      await source.query(
        'SELECT profile_id FROM identities WHERE profile_id=?',
        [transportTarget.target_id]
      )
    ).toEqual([]);
    await worker.runTarget(target, membershipTestOptions());
    const retries = membershipTestOptions({ retry_millis: 60000 });
    for (let attempt = 1; attempt <= 3; attempt++) {
      const result = await worker.runTarget(transportTarget, {
        ...retries,
        deadline_monotonic_millis: performance.now() + 30000
      });
      expect(result.outcome).toBe(attempt === 3 ? 'FAILED' : 'PENDING');
      const observed = await tx((ctx) => service.advance(ctx));
      expect(
        observed.state.proof?.identity_retry?.observations.map(
          (entry) => entry.attempts
        )
      ).toEqual(Array.from({ length: attempt }, (_, index) => index + 1));
      if (attempt < 3) {
        expect(
          (await worker.runTarget(transportTarget, membershipTestOptions()))
            .outcome
        ).toBe('NO_WORK');
        const pending = await tx((ctx) =>
          new MembershipRefreshTargetsDb(() => db).find(transportTarget, ctx)
        );
        expect(pending?.attempts).toBe(attempt);
        await harness.setMysqlTime(
          String(BigInt(pending!.available_at_millis!) + BigInt(1000))
        );
      } else expect(observed.state.scenario).toBe('FANOUT_WAIT');
    }
    const fanoutPage = await worker.runTarget(
      full,
      membershipTestOptions({ page_size: 1 })
    );
    expect(fanoutPage.outcome).toBe('PENDING');
    const restored = await tx((ctx) => service.advance(ctx));
    expect(restored.state.scenario).toBe('FANOUT_CAPTURED');
    expect(restored.state.proof?.fanout?.captured).toMatchObject({
      run_id: fanoutPage.run_id,
      through_id: MEMBERSHIP_FIXTURE_PROFILES[0],
      after_id: MEMBERSHIP_FIXTURE_PROFILES[2]
    });
    expect(
      await source.query(
        'SELECT profile_id FROM identities WHERE profile_id=?',
        [transportTarget.target_id]
      )
    ).toEqual([{ profile_id: transportTarget.target_id }]);
    await finish(full);
    const acknowledged = await tx((ctx) => service.advance(ctx));
    expect(acknowledged.state.scenario).toBe('FANOUT_CAPTURED');
    expect(
      acknowledged.state.proof?.fanout?.captured?.completed_observed_at_millis
    ).not.toBeNull();
    expect(
      (
        await tx((ctx) =>
          new MembershipRefreshTargetsDb(() => db).find(transportTarget, ctx)
        )
      )?.requested_version
    ).toBe(
      restored.state.proof?.fanout?.captured?.restored_profile_request_version
    );
    for (const target_id of MEMBERSHIP_FIXTURE_PROFILES)
      await finish({ scope: 'PROFILE', target_id });
    expect((await tx((ctx) => service.advance(ctx))).state.scenario).toBe(
      'IDENTITY_RECOVERED'
    );
  });
  it('reconciles an acknowledged-lost group CREATE before the generated metadata row is installed', async () => {
    const actual = schemaExecution.executeMembershipOnlineIndex;
    const spy = jest
      .spyOn(schemaExecution, 'executeMembershipOnlineIndex')
      .mockImplementation(async (runner, sql, deadline) => {
        await actual(runner, sql, deadline);
        if (sql.startsWith('CREATE TABLE `community_groups`'))
          throw new Error('lost-create-ack');
      });
    await expect(schema()).rejects.toThrow('lost-create-ack');
    spy.mockRestore();
    await schema();
    expect(
      await source.query('SELECT `table`,`name` FROM typeorm_metadata')
    ).toEqual([{ table: 'community_groups', name: 'is_pure_profile_group' }]);
    expect((await prepare()).state.setup_stage).toBe('READY');
  });
  it('rolls back the whole catalogue and resumes after an actual group insert fault', async () => {
    await schema();
    for (let n = 0; n < 5; n++) await tx((ctx) => service.prepare(ctx));
    const execute = db.execute.bind(db);
    const spy = jest
      .spyOn(db, 'execute')
      .mockImplementation(async (sql, params, options) => {
        const result = await execute(sql, params, options);
        if (sql.startsWith('INSERT INTO `community_groups`'))
          throw new Error('catalogue-write-fault');
        return result;
      });
    await expect(tx((ctx) => service.prepare(ctx))).rejects.toThrow(
      'catalogue-write-fault'
    );
    spy.mockRestore();
    expect(await db.execute('SELECT id FROM community_groups')).toEqual([]);
    const pending = await tx((ctx) =>
      new MembershipFixtureControlDb(db).read(ctx)
    );
    expect(pending?.state.setup_stage).toBe('INPUTS_READY');
    const sources = await tx((ctx) =>
      new MembershipSourceStatesDb(() => db).read(
        MEMBERSHIP_FIXTURE_SOURCE_KEYS,
        false,
        ctx
      )
    );
    expect(
      sources.find(({ key }) => key.dimension === 'GROUP_CATALOG')?.state
        ?.version
    ).toBe('0');
    await prepare();
    expect((await tx((ctx) => service.status(ctx))).candidates).toHaveLength(
      36
    );
  });
  it('rejects unknown objects and populated unowned data without adopting or deleting them', async () => {
    await source.query('CREATE TABLE unexpected_fixture_object(id int)');
    await expect(schema()).rejects.toThrow('unknown objects');
    await source.query('DROP TABLE unexpected_fixture_object');
    await schema();
    await source.query(
      "INSERT INTO identities(consolidation_key,profile_id,primary_address,tdh,rep,cic,level_raw) VALUES('unknown','unknown','unknown',0,0,0,0)"
    );
    await expect(
      prepareMembershipFixtureSchema(source, environment)
    ).rejects.toThrow('populated unowned');
    await expect(tx((ctx) => service.prepare(ctx))).rejects.toThrow(
      'populated unowned'
    );
    expect(await source.query('SELECT profile_id FROM identities')).toEqual([
      { profile_id: 'unknown' }
    ]);
  });
  it('rolls back actual seeded input and checkpoint on a write failure, then resumes exactlyonce', async () => {
    await schema();
    await tx((ctx) => service.prepare(ctx));
    await tx((ctx) => service.prepare(ctx));
    const execute = db.execute.bind(db);
    const spy = jest
      .spyOn(db, 'execute')
      .mockImplementation(async (sql, params, options) => {
        const result = await execute(sql, params, options);
        if (sql.startsWith('INSERT INTO `nft_owners`'))
          throw new Error('after-real-nft-write');
        return result;
      });
    await expect(tx((ctx) => service.prepare(ctx))).rejects.toThrow(
      'after-real-nft-write'
    );
    spy.mockRestore();
    expect(await db.execute('SELECT profile_id FROM identities')).toEqual([]);
    const control = await tx((ctx) =>
      new MembershipFixtureControlDb(db).read(ctx)
    );
    expect(control?.state.input_page).toBe(0);
    await prepare();
    expect(
      (await tx((ctx) => service.status(ctx))).sources.every(
        (row) => row.active_jobs === 0
      )
    ).toBe(true);
  });
  it('refuses cleanup when a table contains a row outside the exact fixture manifest', async () => {
    await schema();
    await prepare();
    const controls = new MembershipFixtureControlDb(db);
    const cleaning = await tx((ctx) => service.cleanup(ctx));
    await source.query(
      "INSERT INTO membership_publications(profile_id,run_id,published_at_millis) VALUES('unowned-profile','11111111-1111-4111-8111-111111111111',1)"
    );
    await tx((ctx) =>
      controls.update(
        cleaning.revision,
        { ...cleaning.state, cleanup_not_before_millis: '0' },
        ctx
      )
    );
    await expect(tx((ctx) => service.cleanup(ctx))).rejects.toThrow(
      'unowned row'
    );
    expect(
      await db.execute('SELECT profile_id FROM membership_publications')
    ).toEqual([{ profile_id: 'unowned-profile' }]);
  });
  it('refuses a NULL identity ownership field without deleting any identities or advancing cleanup', async () => {
    await schema();
    await prepare();
    const controls = new MembershipFixtureControlDb(db);
    const cleaning = await tx((ctx) => service.cleanup(ctx));
    await source.query(
      'UPDATE identities SET profile_id=NULL WHERE profile_id=?',
      [MEMBERSHIP_FIXTURE_PROFILES[0]]
    );
    const before = await source.query(
      'SELECT profile_id,consolidation_key,primary_address FROM identities ORDER BY profile_id'
    );
    const ready = await tx((ctx) =>
      controls.update(
        cleaning.revision,
        {
          ...cleaning.state,
          cleanup_not_before_millis: '0',
          cleanup_table:
            MEMBERSHIP_FIXTURE_CLEANUP_TABLES.indexOf(IDENTITIES_TABLE)
        },
        ctx
      )
    );
    await expect(tx((ctx) => service.cleanup(ctx))).rejects.toThrow(
      'unowned row'
    );
    expect(
      await source.query(
        'SELECT profile_id,consolidation_key,primary_address FROM identities ORDER BY profile_id'
      )
    ).toEqual(before);
    expect(await tx((ctx) => controls.read(ctx))).toEqual(ready);
  });
  it('fences stale control revisions and enforces cleanup grace without dropping owned schema', async () => {
    await schema();
    const ready = await prepare();
    const controls = new MembershipFixtureControlDb(db);
    await tx((ctx) =>
      controls.update(
        ready.revision,
        { ...ready.state, scenario: 'MISSED_WAKEUP' },
        ctx
      )
    );
    await expect(
      tx((ctx) => controls.update(ready.revision, ready.state, ctx))
    ).rejects.toThrow('revision conflict');
    const cleaning = await tx((ctx) => service.cleanup(ctx));
    expect(cleaning.state.setup_stage).toBe('CLEANING');
    await expect(tx((ctx) => service.cleanup(ctx))).rejects.toThrow(
      'reader grace'
    );
    // Test-only clock movement; production advance never accepts timestamps.
    await tx((ctx) =>
      controls.update(
        cleaning.revision,
        { ...cleaning.state, cleanup_not_before_millis: '0' },
        ctx
      )
    );
    for (let n = 0; n < 40; n++) {
      const result = await tx((ctx) => service.cleanup(ctx));
      if (result.state.setup_stage === 'CLEANED') break;
    }
    const finished = await tx((ctx) => controls.read(ctx));
    expect(finished?.state.setup_stage).toBe('CLEANED');
    expect(finished?.manifest_hash).toBe(MEMBERSHIP_FIXTURE_MANIFEST_HASH);
    expect(await db.execute('SELECT id FROM community_groups')).toEqual([]);
    await expect(tx((ctx) => service.prepare(ctx))).rejects.toThrow(
      'cannot be automatically reused'
    );
  });
});
