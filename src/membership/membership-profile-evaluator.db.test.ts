import { performance } from 'node:perf_hooks';
import {
  ADDRESS_CONSOLIDATION_KEY,
  EXTERNAL_INDEXED_OWNERSHIP_721_TABLE,
  IDENTITIES_TABLE,
  MEMBERSHIP_GROUP_VERSIONS_TABLE,
  MEMBERSHIP_SOURCE_STATES_TABLE,
  MEMES_CONTRACT,
  NFT_OWNERS_TABLE,
  PROFILE_GROUPS_TABLE,
  RATINGS_TABLE,
  USER_GROUPS_TABLE,
  WAVES_TABLE,
  XTDH_GRANTS_TABLE,
  XTDH_GRANT_TOKENS_TABLE
} from '@/constants';
import { sqlExecutor, setSqlExecutor } from '@/sql-executor';
import * as loopDb from '@/db';
import { describeWithSeed } from '@/tests/_setup/seed';
import { anIdentity, withIdentities } from '@/tests/fixtures/identity.fixture';
import {
  aUserGroup,
  withUserGroups
} from '@/tests/fixtures/user-group.fixture';
import { aWave } from '@/tests/fixtures/wave.fixture';
import {
  UserGroupEntity,
  FilterDirection,
  GroupTdhInclusionStrategy,
  GroupBeneficiaryGrantMatchMode,
  GroupNftOwnershipMatchMode
} from '@/entities/IUserGroup';
import { UserGroupsDb } from '@/user-groups/user-groups.db';
import { UserGroupsService } from '@/api/community-members/user-groups.service';
import {
  PrimaryMembershipProfileEvaluator,
  membershipProfileSourceKeys
} from '@/membership/membership-profile-evaluator';
import {
  MembershipEvaluationQuantumInput,
  MembershipEvaluationQuantumResult,
  MembershipProfileEvaluationSeed
} from '@/membership/membership-evaluator.types';
import {
  MembershipPrimaryContext,
  membershipExecutionBudget,
  withMembershipPrimaryTransaction
} from '@/membership/membership-primary';
import { MembershipSourceStatesDb } from '@/membership/membership-source-states.db';

const profile = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001';
const address = (n: number) => `0x${String(n).padStart(40, '0')}`;
const identity = anIdentity(
  { tdh: 10, xtdh: 10.9, rep: 30, cic: 0, level_raw: 24 },
  {
    profile_id: profile,
    consolidation_key: address(1),
    primary_address: address(1),
    handle: 'membership-evaluator'
  }
);
const evaluator = () =>
  new PrimaryMembershipProfileEvaluator(() => sqlExecutor);
const tx = <T>(fn: (ctx: MembershipPrimaryContext) => Promise<T>) =>
  withMembershipPrimaryTransaction(
    sqlExecutor,
    fn,
    {},
    {
      deadlineMonotonicMillis: performance.now() + 15000,
      maxStatementMillis: 3000,
      finalizationReserveMillis: 500,
      lockWaitSeconds: 1
    }
  );
const limits = {
  max_queries: 256,
  max_input_rows: 65536,
  max_input_bytes: 4 * 1024 * 1024,
  max_windows: 32,
  raw_window: 8
};
async function insertRows(table: string, rows: object[]) {
  if (rows.length)
    await sqlExecutor.bulkInsert(table, rows, Object.keys(rows[0]));
}
async function provision() {
  await withMembershipPrimaryTransaction(sqlExecutor, (ctx) =>
    new MembershipSourceStatesDb(() => sqlExecutor).provision(
      membershipProfileSourceKeys(profile),
      { bootstrap_id: 'm3-test', coverage_revision: 'isolated-fixture' },
      ctx
    )
  );
}
async function groups(rows: UserGroupEntity[]) {
  await insertRows(USER_GROUPS_TABLE, withUserGroups(rows).rows);
  await insertRows(
    MEMBERSHIP_GROUP_VERSIONS_TABLE,
    rows.map((g) => ({
      group_id: g.id,
      catalog_version: '0',
      is_deleted: false,
      updated_at_millis: '1'
    }))
  );
  await insertRows(
    WAVES_TABLE,
    rows.map((g) => {
      const { serial_no, ...wave } = aWave(
        { visibility_group_id: g.id },
        { id: `wave-${g.id}`, name: g.id }
      );
      return wave;
    })
  );
}
function group(id: string, values: Partial<UserGroupEntity>): UserGroupEntity {
  return aUserGroup(values, { id, name: id });
}
async function quantum(
  seed: MembershipProfileEvaluationSeed,
  after: string | null = null,
  active: MembershipEvaluationQuantumInput['active_input'] = null,
  overrides: Partial<typeof limits> = {}
): Promise<MembershipEvaluationQuantumResult> {
  return tx((ctx) =>
    evaluator().evaluateQuantum(
      {
        ...seed,
        after_group_id: after,
        active_input: active,
        max_scanned_groups: 8,
        max_query_millis: 3000,
        deadline_monotonic_millis:
          membershipExecutionBudget(ctx).workDeadlineMonotonicMillis,
        limits: { ...limits, ...overrides }
      },
      ctx
    )
  );
}
async function complete(
  seed: MembershipProfileEvaluationSeed,
  overrides: Partial<typeof limits> = {}
) {
  let after: string | null = null;
  let active: MembershipEvaluationQuantumInput['active_input'] = null;
  const ids: string[] = [];
  const results: MembershipEvaluationQuantumResult[] = [];
  for (let n = 0; n < 300; n++) {
    const result = await quantum(seed, after, active, overrides);
    results.push(result);
    ids.push(...result.eligible_group_ids);
    after = result.after_group_id;
    active = result.active_input;
    if (result.done) return { ids, results };
  }
  throw new Error('Fixture failed to finish bounded evaluation');
}
const grantRow = (id: string, values: Record<string, unknown> = {}) => ({
  id,
  tokenset_id: 'tokens',
  replaced_grant_id: null,
  grantor_id: 'grantor',
  target_chain: 1,
  target_contract: address(3),
  target_partition: '1:fixture',
  token_mode: 'INCLUDE',
  created_at: 1,
  updated_at: 1,
  valid_from: 1,
  valid_to: null,
  rate: 1,
  status: 'GRANTED',
  error_details: null,
  is_irrevocable: false,
  ...values
});
const externalOwner = (
  token: string,
  owner = address(1),
  partition = '1:fixture'
) => ({
  partition,
  token_id: token,
  owner,
  since_block: 1,
  since_time: 1,
  sale_epoch_start_block: null,
  sale_epoch_tx: null,
  free_transfers_since_epoch: 0,
  created_at: 1,
  updated_at: 1
});
const direct = async (ids: string[]) =>
  new UserGroupsService(
    new UserGroupsDb(() => sqlExecutor),
    {} as never,
    {} as never
  ).getGroupsUserIsEligibleForByIds(profile, ids);

describeWithSeed(
  'Primary membership evaluator bounded inputs',
  withIdentities([identity]),
  () => {
    beforeEach(provision);
    it('captures all13 proven source keys and rejects missing or active evidence', async () => {
      const seed = await tx((ctx) => evaluator().captureProfile(profile, ctx));
      expect(seed.source_versions).toHaveLength(13);
      expect(seed.identity_consolidation_key).toBe(address(1));
      await sqlExecutor.execute(
        `UPDATE ${MEMBERSHIP_SOURCE_STATES_TABLE} SET active_jobs=1 WHERE scope='GLOBAL' AND dimension='GRANTS'`
      );
      await expect(
        tx((ctx) => evaluator().captureProfile(profile, ctx))
      ).rejects.toThrow('evidence');
    });
    it('rejects zero and multiple identity rows even though the profile index is nonunique', async () => {
      await sqlExecutor.execute(`DELETE FROM ${IDENTITIES_TABLE}`);
      await expect(
        tx((ctx) => evaluator().captureProfile(profile, ctx))
      ).rejects.toMatchObject({ code: 'IDENTITY_NOT_FOUND' });
      await insertRows(IDENTITIES_TABLE, [
        identity,
        {
          ...identity,
          consolidation_key: address(2),
          primary_address: address(2)
        }
      ]);
      await expect(
        tx((ctx) => evaluator().captureProfile(profile, ctx))
      ).rejects.toMatchObject({ code: 'INTEGRITY' });
    });
    it('matches current direct semantics for inclusion/exclusion, zero bounds, levels, TDH floors and private groups', async () => {
      const rows = [
        group('a-include', { profile_group_id: 'LIST-Include', tdh_min: 999 }),
        group('b-exclude', {
          profile_group_id: 'LIST-Include',
          excluded_profile_group_id: 'List-Exclude'
        }),
        group('c-exclusion-only', { excluded_profile_group_id: 'absent' }),
        group('d-empty', {}),
        group('e-level-zero', { level_max: 0 }),
        group('f-cic-zero', { cic_min: 0, cic_max: 0 }),
        group('g-xtdh-floor', {
          tdh_min: 10,
          tdh_max: 10,
          tdh_inclusion_strategy: GroupTdhInclusionStrategy.XTDH
        }),
        group('h-both-floor', {
          tdh_min: 20,
          tdh_max: 20,
          tdh_inclusion_strategy: GroupTdhInclusionStrategy.BOTH
        }),
        group('i-private', { is_private: true, tdh_min: 10 }),
        group('j-false', { level_min: 1 })
      ];
      await groups(rows);
      await insertRows(PROFILE_GROUPS_TABLE, [
        { profile_group_id: 'list-include', profile_id: profile },
        { profile_group_id: 'list-exclude', profile_id: profile }
      ]);
      const expected = await direct(rows.map((g) => g.id));
      const result = await complete(
        await tx((ctx) => evaluator().captureProfile(profile, ctx))
      );
      expect(result.ids.sort((a, b) => a.localeCompare(b))).toEqual(
        expected.sort((a, b) => a.localeCompare(b))
      );
      expect(result.ids).toContain('e-level-zero');
      expect(result.ids).not.toContain('b-exclude');
    });
    it('resumes signed rating sums across more than16 quanta without accepting a partial threshold', async () => {
      await groups([
        group('a-rating', {
          rep_category: 'dense',
          rep_direction: FilterDirection.Sent,
          rep_min: 100
        })
      ]);
      await insertRows(
        RATINGS_TABLE,
        Array.from({ length: 40 }, (_, n) => ({
          rater_profile_id: profile,
          matter_target_id: `peer-${String(n).padStart(3, '0')}`,
          matter: 'REP',
          matter_category: 'dense',
          rating: n === 39 ? -3899 : 100,
          last_modified: new Date()
        }))
      );
      const result = await complete(
        await tx((ctx) => evaluator().captureProfile(profile, ctx)),
        { max_windows: 1, raw_window: 1 }
      );
      expect(result.results.length).toBeGreaterThan(40);
      expect(result.ids).toEqual([]);
      expect(
        result.results
          .filter((r) => r.kind === 'INPUT_PENDING')
          .every(
            (r) =>
              r.after_group_id === null && r.eligible_group_ids.length === 0
          )
      ).toBe(true);
      expect(await direct(['a-rating'])).toEqual([]);
    });
    it('matches granular incoming/user/category and outgoing-total signed/zero axes', async () => {
      await groups([
        group('a-incoming', {
          rep_user: 'peer',
          rep_category: 'category',
          rep_min: 0,
          rep_max: 0
        }),
        group('b-outgoing', {
          cic_direction: FilterDirection.Sent,
          cic_min: -3,
          cic_max: -3
        }),
        group('c-nonzero', { rep_user: 'peer', rep_category: 'category' })
      ]);
      await insertRows(RATINGS_TABLE, [
        {
          rater_profile_id: 'peer',
          matter_target_id: profile,
          matter: 'REP',
          matter_category: 'category',
          rating: 0,
          last_modified: new Date()
        },
        {
          rater_profile_id: profile,
          matter_target_id: 'peer',
          matter: 'CIC',
          matter_category: '',
          rating: -3,
          last_modified: new Date()
        }
      ]);
      const result = await complete(
        await tx((ctx) => evaluator().captureProfile(profile, ctx))
      );
      expect(result.ids).toEqual(['a-incoming', 'b-outgoing']);
      expect(await direct(['a-incoming', 'b-outgoing', 'c-nonzero'])).toEqual(
        result.ids
      );
    });
    it('uses raw profile-list windows so a late case-insensitive exclusion is not missed', async () => {
      await groups([
        group('a-late-exclusion', { excluded_profile_group_id: 'Z-EXCLUDED' })
      ]);
      await insertRows(PROFILE_GROUPS_TABLE, [
        ...Array.from({ length: 24 }, (_, n) => ({
          profile_id: profile,
          profile_group_id: `a-${String(n).padStart(3, '0')}`
        })),
        { profile_id: profile, profile_group_id: 'z-excluded' }
      ]);
      const result = await complete(
        await tx((ctx) => evaluator().captureProfile(profile, ctx)),
        { max_windows: 1, raw_window: 4 }
      );
      expect(result.ids).toEqual([]);
      expect(result.results.length).toBeGreaterThan(6);
    });
    it('resumes all128 consolidated wallets and preserves zero-balance ownership', async () => {
      await groups([group('a-wallet', { owns_meme: true })]);
      await insertRows(
        ADDRESS_CONSOLIDATION_KEY,
        Array.from({ length: 128 }, (_, n) => ({
          address: address(n + 1),
          consolidation_key: identity.consolidation_key
        }))
      );
      await insertRows(NFT_OWNERS_TABLE, [
        {
          token_id: 1,
          contract: MEMES_CONTRACT,
          wallet: address(128),
          balance: 0,
          block_reference: 1
        }
      ]);
      const result = await complete(
        await tx((ctx) => evaluator().captureProfile(profile, ctx)),
        { max_windows: 1, raw_window: 8 }
      );
      expect(result.ids).toEqual(['a-wallet']);
      expect(result.results.length).toBeGreaterThan(16);
    });
    it('streams required JSON tokens and owner rows while retaining exact required strings', async () => {
      await groups([
        group('a-owned', {
          owns_meme: true,
          owns_meme_tokens: JSON.stringify(['1', '2', '2'])
        }),
        group('b-leading-zero', {
          owns_meme: true,
          owns_meme_tokens: JSON.stringify(['01'])
        })
      ]);
      await insertRows(ADDRESS_CONSOLIDATION_KEY, [
        { address: address(1), consolidation_key: identity.consolidation_key },
        { address: address(2), consolidation_key: identity.consolidation_key }
      ]);
      await insertRows(NFT_OWNERS_TABLE, [
        {
          token_id: 1,
          contract: MEMES_CONTRACT,
          wallet: address(1),
          balance: 1,
          block_reference: 1
        },
        {
          token_id: 2,
          contract: MEMES_CONTRACT,
          wallet: address(2),
          balance: 1,
          block_reference: 1
        }
      ]);
      const result = await complete(
        await tx((ctx) => evaluator().captureProfile(profile, ctx)),
        { max_windows: 1 }
      );
      expect(result.ids).toEqual(['a-owned']);
      expect(await direct(['a-owned', 'b-leading-zero'])).toEqual(result.ids);
    });
    it('keeps status-only grant predicates and a false PENDING future horizon before early exclusion', async () => {
      const now = Date.now();
      const partition = '1:fixture';
      await groups([
        group('a-pending', {
          excluded_profile_group_id: 'excluded',
          is_beneficiary_of_grant_id: 'pending'
        }),
        group('b-future-granted', { is_beneficiary_of_grant_id: 'future' }),
        group('c-all', {
          is_beneficiary_of_grant_id: 'future',
          is_beneficiary_of_grant_match_mode:
            GroupBeneficiaryGrantMatchMode.ALL_TOKENS
        })
      ]);
      await insertRows(PROFILE_GROUPS_TABLE, [
        { profile_group_id: 'excluded', profile_id: profile }
      ]);
      await insertRows(ADDRESS_CONSOLIDATION_KEY, [
        { address: address(1), consolidation_key: identity.consolidation_key }
      ]);
      const grant = {
        tokenset_id: 'tokens',
        replaced_grant_id: null,
        grantor_id: 'grantor',
        target_chain: 1,
        target_contract: address(3),
        target_partition: partition,
        token_mode: 'INCLUDE',
        created_at: now,
        updated_at: now,
        valid_from: now + 60000,
        valid_to: now + 120000,
        rate: 1,
        status: 'GRANTED',
        error_details: null,
        is_irrevocable: false
      };
      await insertRows(XTDH_GRANTS_TABLE, [
        { ...grant, id: 'future' },
        { ...grant, id: 'pending', status: 'PENDING', valid_from: now + 30000 }
      ]);
      await insertRows(
        XTDH_GRANT_TOKENS_TABLE,
        Array.from({ length: 25 }, (_, n) => ({
          tokenset_id: 'tokens',
          token_id: String(n + 1),
          target_partition: partition
        }))
      );
      await insertRows(
        EXTERNAL_INDEXED_OWNERSHIP_721_TABLE,
        Array.from({ length: 25 }, (_, n) => ({
          partition,
          token_id: String(n + 1),
          owner: address(1),
          since_block: 1,
          since_time: now,
          sale_epoch_start_block: null,
          sale_epoch_tx: null,
          free_transfers_since_epoch: 0,
          created_at: now,
          updated_at: now
        }))
      );
      const result = await complete(
        await tx((ctx) => evaluator().captureProfile(profile, ctx)),
        { max_windows: 1, raw_window: 3 }
      );
      expect(result.ids).toEqual(['b-future-granted', 'c-all']);
      expect(
        result.results.some((r) => r.valid_until_millis === String(now + 30000))
      ).toBe(true);
      expect(await direct(['a-pending', 'b-future-granted', 'c-all'])).toEqual(
        result.ids
      );
    });
    it('resumes numeric grant windows across partitions and preserves late ANY / missing ALL outcomes', async () => {
      await groups([
        group('a-any', { is_beneficiary_of_grant_id: 'grant' }),
        group('b-all-missing', {
          is_beneficiary_of_grant_id: 'grant',
          is_beneficiary_of_grant_match_mode:
            GroupBeneficiaryGrantMatchMode.ALL_TOKENS
        }),
        group('c-empty', { is_beneficiary_of_grant_id: 'empty' }),
        group('d-all-empty', {
          is_beneficiary_of_grant_id: 'empty',
          is_beneficiary_of_grant_match_mode:
            GroupBeneficiaryGrantMatchMode.ALL_TOKENS
        })
      ]);
      await insertRows(XTDH_GRANTS_TABLE, [
        grantRow('grant'),
        grantRow('empty', { tokenset_id: 'empty-tokens' })
      ]);
      await insertRows(ADDRESS_CONSOLIDATION_KEY, [
        { address: address(1), consolidation_key: identity.consolidation_key }
      ]);
      await insertRows(XTDH_GRANT_TOKENS_TABLE, [
        { tokenset_id: 'tokens', token_id: '2', target_partition: 'other' },
        { tokenset_id: 'tokens', token_id: '10', target_partition: 'other' },
        {
          tokenset_id: 'tokens',
          token_id: '100',
          target_partition: '1:fixture'
        },
        {
          tokenset_id: 'tokens',
          token_id: '9007199254740993',
          target_partition: '1:fixture'
        }
      ]);
      await insertRows(EXTERNAL_INDEXED_OWNERSHIP_721_TABLE, [
        externalOwner('100')
      ]);
      const result = await complete(
        await tx((ctx) => evaluator().captureProfile(profile, ctx)),
        { raw_window: 1, max_windows: 1 }
      );
      expect(result.ids).toEqual(['a-any']);
      const cursors = result.results.flatMap((r) =>
        r.active_input?.stage.kind === 'GRANT_INCLUDE' &&
        r.active_input.stage.after_token_id
          ? [r.active_input.stage.after_token_id]
          : []
      );
      expect(cursors).toEqual(expect.arrayContaining(['2', '10', '100']));
      expect(
        await direct(['a-any', 'b-all-missing', 'c-empty', 'd-all-empty'])
      ).toEqual(result.ids);
    });
    it('evaluates ALL grant mode over every wallet and keeps ALL_TOKENS false', async () => {
      await groups([
        group('a-any', { is_beneficiary_of_grant_id: 'grant' }),
        group('b-all', {
          is_beneficiary_of_grant_id: 'grant',
          is_beneficiary_of_grant_match_mode:
            GroupBeneficiaryGrantMatchMode.ALL_TOKENS
        }),
        group('c-absent', { is_beneficiary_of_grant_id: 'absent' })
      ]);
      await insertRows(XTDH_GRANTS_TABLE, [
        grantRow('grant', { token_mode: 'ALL', tokenset_id: null }),
        grantRow('absent', {
          token_mode: 'ALL',
          tokenset_id: null,
          target_partition: 'absent'
        })
      ]);
      await insertRows(
        ADDRESS_CONSOLIDATION_KEY,
        Array.from({ length: 32 }, (_, n) => ({
          address: address(n + 1),
          consolidation_key: identity.consolidation_key
        }))
      );
      await insertRows(EXTERNAL_INDEXED_OWNERSHIP_721_TABLE, [
        externalOwner('1', address(32))
      ]);
      const result = await complete(
        await tx((ctx) => evaluator().captureProfile(profile, ctx)),
        { raw_window: 4, max_windows: 1 }
      );
      expect(result.ids).toEqual(['a-any']);
      expect(result.results.length).toBeGreaterThan(16);
      expect(await direct(['a-any', 'b-all', 'c-absent'])).toEqual(result.ids);
    });
    it('keeps native JSON input transfer bounded and completes a late ANY witness', async () => {
      const required = [
        ...Array.from({ length: 65 }, (_, n) => String(n + 10)),
        '1'
      ];
      await groups([
        group('a-json', {
          owns_meme: true,
          owns_meme_tokens: JSON.stringify(required),
          owns_meme_tokens_match_mode: GroupNftOwnershipMatchMode.ANY_TOKEN
        })
      ]);
      await insertRows(ADDRESS_CONSOLIDATION_KEY, [
        { address: address(1), consolidation_key: identity.consolidation_key }
      ]);
      await insertRows(NFT_OWNERS_TABLE, [
        {
          token_id: 1,
          contract: MEMES_CONTRACT,
          wallet: address(1),
          balance: 1,
          block_reference: 1
        }
      ]);
      const execute = jest.spyOn(sqlExecutor, 'execute');
      try {
        const result = await complete(
          await tx((ctx) => evaluator().captureProfile(profile, ctx)),
          { raw_window: 1, max_windows: 1 }
        );
        expect(result.ids).toEqual(['a-json']);
        expect(result.results.length).toBeGreaterThan(65);
        const extraction = execute.mock.calls.filter(([sql]) =>
          sql.includes('JSON_EXTRACT')
        );
        expect(extraction).toHaveLength(66);
        expect(
          extraction.every(
            ([sql]) =>
              sql.includes('LEFT(JSON_UNQUOTE') && !sql.includes('JSON_TABLE')
          )
        ).toBe(true);
      } finally {
        execute.mockRestore();
      }
    });
    it('falls back to canonical pages when one list references more than8 raw visible groups', async () => {
      const rows = Array.from({ length: 25 }, (_, n) =>
        group(`group-${String(n).padStart(2, '0')}`, {
          profile_group_id: 'shared'
        })
      );
      await groups(rows);
      await insertRows(PROFILE_GROUPS_TABLE, [
        { profile_group_id: 'shared', profile_id: profile }
      ]);
      const result = await complete(
        await tx((ctx) => evaluator().captureProfile(profile, ctx))
      );
      expect(result.ids).toEqual(rows.map((g) => g.id));
      expect(result.results.length).toBeGreaterThan(1);
      expect(
        result.results.every(
          (r) => r.scanned_count <= 8 && r.query_count <= limits.max_queries
        )
      ).toBe(true);
    });
    it('blocks active source barriers without mutating caller continuation', async () => {
      await groups([group('a-slow', { tdh_min: 0 })]);
      const seed = await tx((ctx) => evaluator().captureProfile(profile, ctx));
      const first = await quantum(seed, null, null, { max_windows: 1 });
      const saved = JSON.stringify(first.active_input);
      await sqlExecutor.execute(
        `UPDATE ${MEMBERSHIP_SOURCE_STATES_TABLE} SET active_jobs=1 WHERE dimension='GROUP_CATALOG'`
      );
      await expect(quantum(seed, null, first.active_input)).rejects.toThrow(
        'evidence'
      );
      expect(JSON.stringify(first.active_input)).toBe(saved);
    });
    it('requires a tombstone when an active group disappears and then advances without membership', async () => {
      await groups([group('a-slow', { tdh_min: 0 })]);
      const seed = await tx((ctx) => evaluator().captureProfile(profile, ctx));
      const first = await quantum(seed, null, null, { max_windows: 1 });
      await sqlExecutor.execute(
        `DELETE FROM ${USER_GROUPS_TABLE} WHERE id='a-slow'`
      );
      await expect(
        quantum(seed, null, first.active_input)
      ).rejects.toMatchObject({ code: 'INTEGRITY' });
      await sqlExecutor.execute(
        `UPDATE ${MEMBERSHIP_GROUP_VERSIONS_TABLE} SET is_deleted=1 WHERE group_id='a-slow'`
      );
      const next = await quantum(seed, null, first.active_input);
      expect(next.eligible_group_ids).toEqual([]);
      expect(next.after_group_id).toBe('a-slow');
      expect(next.active_input).toBeNull();
    });
    it('supersedes noncatalogue changes but retains C and resumes unchanged groups after unrelated catalogue changes', async () => {
      await groups([
        group('a-slow', {
          rep_category: 'dense',
          rep_direction: FilterDirection.Sent,
          rep_min: 0
        })
      ]);
      const seed = await tx((ctx) => evaluator().captureProfile(profile, ctx));
      const first = await quantum(seed, null, null, { max_windows: 1 });
      expect(first.kind).toBe('INPUT_PENDING');
      await sqlExecutor.execute(
        `UPDATE ${MEMBERSHIP_SOURCE_STATES_TABLE} SET version=1 WHERE dimension='GROUP_CATALOG'`
      );
      const second = await quantum(
        seed,
        first.after_group_id,
        first.active_input,
        { max_windows: 1 }
      );
      expect(second.kind).toBe('INPUT_PENDING');
      expect(second.active_input?.group_version).toBe('0');
      expect(seed.catalog_version).toBe('0');
      await sqlExecutor.execute(
        `UPDATE ${MEMBERSHIP_SOURCE_STATES_TABLE} SET version=1 WHERE scope='PROFILE' AND dimension='RATINGS'`
      );
      await expect(
        quantum(seed, second.after_group_id, second.active_input)
      ).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
    });
    it('restarts only an edited active group and rejects unversioned scalar contradictions', async () => {
      await groups([
        group('a-slow', {
          rep_category: 'dense',
          rep_direction: FilterDirection.Sent,
          rep_min: 0
        })
      ]);
      const seed = await tx((ctx) => evaluator().captureProfile(profile, ctx));
      const first = await quantum(seed, null, null, { max_windows: 1 });
      await sqlExecutor.execute(
        `UPDATE ${USER_GROUPS_TABLE} SET rep_min=99 WHERE id='a-slow'`
      );
      await expect(
        quantum(seed, null, first.active_input)
      ).rejects.toMatchObject({ code: 'INTEGRITY' });
      await sqlExecutor.execute(
        `UPDATE ${MEMBERSHIP_SOURCE_STATES_TABLE} SET version=1 WHERE dimension='GROUP_CATALOG'`
      );
      await sqlExecutor.execute(
        `UPDATE ${MEMBERSHIP_GROUP_VERSIONS_TABLE} SET catalog_version=1 WHERE group_id='a-slow'`
      );
      const next = await quantum(seed, null, first.active_input, {
        max_windows: 1
      });
      expect(next.active_input?.group_version).toBe('1');
      expect(next.after_group_id).toBeNull();
    });
    it('uses complete sparse candidates without scanning every unrelated pure group', async () => {
      const rows = Array.from({ length: 60 }, (_, n) =>
        group(`pure-${String(n).padStart(3, '0')}`, {
          profile_group_id: `list-${n}`
        })
      );
      await groups(rows);
      await insertRows(PROFILE_GROUPS_TABLE, [
        { profile_group_id: 'list-40', profile_id: profile }
      ]);
      const result = await complete(
        await tx((ctx) => evaluator().captureProfile(profile, ctx))
      );
      expect(result.ids).toEqual(['pure-040']);
      expect(result.results).toHaveLength(1);
      expect(result.results[0].scanned_count).toBe(1);
      expect(result.results[0].input_rows).toBeLessThan(256);
    });
    it('uses database catalogue order and covers false/hidden/unreferenced groups', async () => {
      await groups([
        group('Z-last', { tdh_min: 0 }),
        group('a-middle', { tdh_min: 0 }),
        group('_first', { tdh_min: 0 }),
        group('invisible', { visible: false, tdh_min: 0 })
      ]);
      const hidden = group('unreferenced', { tdh_min: 0 });
      await insertRows(USER_GROUPS_TABLE, withUserGroups([hidden]).rows);
      const expected = await sqlExecutor.execute<{ id: string }>(
        `SELECT id FROM ${USER_GROUPS_TABLE} WHERE id IN ('Z-last','a-middle','_first') ORDER BY id`
      );
      const result = await complete(
        await tx((ctx) => evaluator().captureProfile(profile, ctx)),
        { max_windows: 1 }
      );
      expect(result.ids).toEqual(expected.map((r) => r.id));
    });
    it('uses the same actual primary evaluator through the loop TypeORM driver numeric shapes', async () => {
      await groups([group('a-level', { level_max: 0, tdh_min: 10 })]);
      const api = sqlExecutor;
      await loopDb.connect();
      try {
        const result = await complete(
          await tx((ctx) => evaluator().captureProfile(profile, ctx))
        );
        expect(result.ids).toEqual(['a-level']);
      } finally {
        await loopDb.disconnect();
        setSqlExecutor(api);
      }
    });
  }
);
