import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import {
  ADDRESS_CONSOLIDATION_KEY,
  CONSOLIDATED_WALLETS_TDH_TABLE,
  IDENTITIES_TABLE,
  IDENTITY_CHAIN_PRINCIPALS_TABLE,
  PROFILES_TABLE
} from '@/constants';
import { addressIdentityId } from '@/identities/address-identity-id';
import { TDH_ONLY_PLANNED_ROWS } from '@/rebuild/manifests/identity.manifest';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { anIdentity } from '@/tests/fixtures/identity.fixture';
import { consolidationKeyOf } from './identity-plan';
import { restoreUntakenPlaceholders } from './placeholder-restore';
import {
  PLACEHOLDERS_FORMAT,
  PlaceholderAtFreezeLine,
  PlaceholderIdentity
} from './placeholders-at-freeze.format';
import { consolidatedTdhRow } from './rebuild-world/consolidated-tdh-row';

const W = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const CREATED_MS = 1_700_000_123_000;
const UPDATED_MS = 1_700_000_456_000;

function line(
  profileId: string,
  wallet: string,
  identity: Partial<PlaceholderIdentity> | null = {}
): PlaceholderAtFreezeLine {
  const handle = `id-${wallet}`;
  return {
    profile_id: profileId,
    wallet,
    handle,
    normalised_handle: handle,
    created_at_ms: CREATED_MS,
    created_by_wallet: wallet,
    updated_at_ms: UPDATED_MS,
    updated_by_wallet: wallet,
    pfp_url: 'https://example.com/p.png',
    banner_1: null,
    banner_2: null,
    website: null,
    classification: 'PSEUDONYM',
    sub_classification: null,
    identity:
      identity === null
        ? null
        : {
            consolidation_key: wallet,
            primary_address: wallet,
            handle,
            normalised_handle: handle,
            pfp: null,
            banner1: null,
            banner2: null,
            classification: 'PSEUDONYM',
            sub_classification: null,
            rep: 0,
            cic: 0,
            wallets: [wallet],
            ...identity
          }
  };
}

function fileOf(lines: PlaceholderAtFreezeLine[]) {
  const header = {
    format: PLACEHOLDERS_FORMAT,
    freeze_ms: 1_764_000_000_000,
    tdh_block: 1,
    exporter_revision: 'test',
    count: lines.length
  };
  const bytes = gzipSync(
    Buffer.from(
      [header, ...lines].map((it) => `${JSON.stringify(it)}\n`).join(''),
      'utf8'
    )
  );
  return { bytes, sha: createHash('sha256').update(bytes).digest('hex') };
}

/** Wallets of the chain identities the mirror wrote. */
const CHAIN = W(0x100);
const BOUND = W(0x101);
const BOUND_TOO = W(0x102);
const UNTAKEN = W(0x201);
const PAIR_LEFT = W(0x202);
const NO_ROW = W(0x203);
const TAKEN = W(0x204);
const CHAIN_KEY = consolidationKeyOf([CHAIN, BOUND, BOUND_TOO]);

describeWithSeed(
  'restoreUntakenPlaceholders',
  [
    {
      table: IDENTITY_CHAIN_PRINCIPALS_TABLE,
      rows: [
        {
          principal_id: `0x${'aa'.repeat(32)}`,
          profile_id: 'p-chain',
          origin: 'imported',
          created_at: 1
        },
        {
          principal_id: `0x${'bb'.repeat(32)}`,
          profile_id: 'p-taken',
          origin: 'placeholder',
          created_at: 1
        }
      ]
    },
    {
      table: ADDRESS_CONSOLIDATION_KEY,
      rows: [CHAIN, BOUND, BOUND_TOO].map((address) => ({
        address,
        consolidation_key: CHAIN_KEY
      }))
    }
  ],
  () => {
    it('restores the ones no chain identity took, as the mirror leaves them', async () => {
      const file = fileOf([
        line('p-bound', BOUND),
        line('p-none', NO_ROW, null),
        line('p-pair', PAIR_LEFT, {
          consolidation_key: consolidationKeyOf([PAIR_LEFT, BOUND_TOO]),
          primary_address: BOUND_TOO,
          wallets: [PAIR_LEFT, BOUND_TOO],
          rep: 4
        }),
        line('p-taken', TAKEN),
        line('p-untaken', UNTAKEN, { rep: 3, cic: 2, pfp: 'pfp' })
      ]);
      const counts = await restoreUntakenPlaceholders(
        file.bytes,
        file.sha,
        sqlExecutor
      );
      expect(counts).toEqual({
        taken: 1,
        profiles: 4,
        identities: 2,
        rekeyed: 1,
        withoutIdentity: 2
      });
      const profiles = await sqlExecutor.execute<{
        external_id: string;
        created_ms: string | number;
        updated_ms: string | number;
        primary_wallet: string;
      }>(
        `select external_id, primary_wallet,
                timestampdiff(microsecond, '1970-01-01 00:00:00', created_at) div 1000 as created_ms,
                timestampdiff(microsecond, '1970-01-01 00:00:00', updated_at) div 1000 as updated_ms
         from ${PROFILES_TABLE} order by external_id`
      );
      expect(
        profiles.map((it) => [
          it.external_id,
          Number(it.created_ms),
          Number(it.updated_ms)
        ])
      ).toEqual(
        ['p-bound', 'p-none', 'p-pair', 'p-untaken'].map((id) => [
          id,
          CREATED_MS,
          UPDATED_MS
        ])
      );
      const identities = await sqlExecutor.execute<Record<string, unknown>>(
        `select consolidation_key, profile_id, primary_address, handle, tdh,
                rep, cic, level_raw, pfp, xtdh, basetdh_rate
         from ${IDENTITIES_TABLE} order by profile_id`
      );
      const numbers = [
        'tdh',
        'rep',
        'cic',
        'level_raw',
        'xtdh',
        'basetdh_rate'
      ];
      expect(
        identities.map((row) => ({
          ...row,
          ...Object.fromEntries(numbers.map((it) => [it, Number(row[it])]))
        }))
      ).toEqual([
        expect.objectContaining({
          consolidation_key: PAIR_LEFT,
          profile_id: 'p-pair',
          primary_address: PAIR_LEFT,
          handle: `id-${PAIR_LEFT}`,
          rep: 4,
          level_raw: 4
        }),
        expect.objectContaining({
          consolidation_key: UNTAKEN,
          profile_id: 'p-untaken',
          primary_address: UNTAKEN,
          tdh: 0,
          rep: 3,
          cic: 2,
          level_raw: 3,
          pfp: 'pfp',
          xtdh: 0,
          basetdh_rate: 0
        })
      ]);
      const keys = await sqlExecutor.execute<{
        address: string;
        consolidation_key: string;
      }>(
        `select address, consolidation_key from ${ADDRESS_CONSOLIDATION_KEY}
         where consolidation_key <> :chain order by address`,
        { chain: CHAIN_KEY }
      );
      expect(keys).toEqual([
        { address: UNTAKEN, consolidation_key: UNTAKEN },
        { address: PAIR_LEFT, consolidation_key: PAIR_LEFT }
      ]);
    });

    it('refuses an untaken id another profiles row holds, and writes no second row', async () => {
      await sqlExecutor.execute(
        `insert into ${PROFILES_TABLE}
           (external_id, handle, normalised_handle, primary_wallet, created_at,
            created_by_wallet, classification)
         values ('p-untaken', 'someone_else', 'someone_else', :wallet,
            timestampadd(second, 1, '2026-01-01 00:00:00'), :wallet,
            'PSEUDONYM')`,
        { wallet: UNTAKEN }
      );
      const file = fileOf([line('p-untaken', UNTAKEN)]);
      await expect(
        restoreUntakenPlaceholders(file.bytes, file.sha, sqlExecutor)
      ).rejects.toThrow(/p-untaken \(handle someone_else\)/);
      const rows = await sqlExecutor.execute<{ handle: string }>(
        `select handle from ${PROFILES_TABLE} where external_id = 'p-untaken'`
      );
      expect(rows).toEqual([{ handle: 'someone_else' }]);
    });
  }
);

const TDH_ONLY = W(0x301);
const PLACEHOLDER_WITH_TDH = W(0x302);
const CHAIN_WITH_TDH = W(0x303);
// No handle, no chain identity and no TDH: an address-only row from before
// switch-on, with a random id. The record takes it too.
const ADDRESS_ONLY = W(0x304);
// A wallet that left an identity after switch-on: the mirror gave its row
// the address's derived id and rebuilds it, so no plan covers it, TDH or not.
const LEFT_AFTER_SWITCH_ON = W(0x305);
// No handle and no profile id at all, as the identity export leaves some:
// the record takes it, and so do the plans.
const NO_PROFILE_ID = W(0x306);

describeWithSeed(
  'the rows the switch-on record takes, which the TDH area rebuilds',
  [
    {
      table: IDENTITIES_TABLE,
      rows: [
        {
          ...anIdentity(
            { tdh: 0 },
            {
              consolidation_key: ADDRESS_ONLY,
              profile_id: 'p-address-only',
              primary_address: ADDRESS_ONLY,
              handle: 'unused'
            }
          ),
          handle: null,
          normalised_handle: null
        },
        {
          ...anIdentity(
            { tdh: 50 },
            {
              consolidation_key: LEFT_AFTER_SWITCH_ON,
              profile_id: addressIdentityId(LEFT_AFTER_SWITCH_ON),
              primary_address: LEFT_AFTER_SWITCH_ON,
              handle: 'unused'
            }
          ),
          handle: null,
          normalised_handle: null
        },
        {
          ...anIdentity(
            { tdh: 0 },
            {
              consolidation_key: NO_PROFILE_ID,
              profile_id: 'unused',
              primary_address: NO_PROFILE_ID,
              handle: 'unused'
            }
          ),
          profile_id: null,
          handle: null,
          normalised_handle: null
        },
        {
          ...anIdentity(
            { tdh: 400 },
            {
              consolidation_key: TDH_ONLY,
              profile_id: 'p-tdh-only',
              primary_address: TDH_ONLY,
              handle: 'unused'
            }
          ),
          handle: null,
          normalised_handle: null
        },
        anIdentity(
          { tdh: 700 },
          {
            consolidation_key: PLACEHOLDER_WITH_TDH,
            profile_id: 'p-placeholder',
            primary_address: PLACEHOLDER_WITH_TDH,
            handle: `id-${PLACEHOLDER_WITH_TDH}`
          }
        ),
        anIdentity(
          { tdh: 900 },
          {
            consolidation_key: CHAIN_WITH_TDH,
            profile_id: 'p-chain',
            primary_address: CHAIN_WITH_TDH,
            handle: 'on_chain'
          }
        )
      ]
    },
    {
      table: ADDRESS_CONSOLIDATION_KEY,
      rows: [
        TDH_ONLY,
        PLACEHOLDER_WITH_TDH,
        CHAIN_WITH_TDH,
        ADDRESS_ONLY,
        LEFT_AFTER_SWITCH_ON,
        NO_PROFILE_ID
      ].map((address) => ({
        address,
        consolidation_key: address
      }))
    },
    {
      table: CONSOLIDATED_WALLETS_TDH_TABLE,
      rows: [
        consolidatedTdhRow(TDH_ONLY, 400),
        consolidatedTdhRow(PLACEHOLDER_WITH_TDH, 700),
        consolidatedTdhRow(CHAIN_WITH_TDH, 900),
        consolidatedTdhRow(LEFT_AFTER_SWITCH_ON, 50)
      ]
    },
    {
      table: IDENTITY_CHAIN_PRINCIPALS_TABLE,
      rows: [
        {
          principal_id: `0x${'cc'.repeat(32)}`,
          profile_id: 'p-chain',
          origin: 'imported',
          created_at: 1
        }
      ]
    }
  ],
  () => {
    it.each(TDH_ONLY_PLANNED_ROWS.map((it) => [it.table, it.where]))(
      'are the handle-less rows without a chain identity in %s, with or without TDH or a profile id, not a placeholder or an address-derived id',
      async (table, where) => {
        const rows = await sqlExecutor.execute<{ consolidation_key: string }>(
          `select consolidation_key from ${table} where ${where} order by consolidation_key`
        );
        expect(rows).toEqual([
          { consolidation_key: TDH_ONLY },
          { consolidation_key: ADDRESS_ONLY },
          { consolidation_key: NO_PROFILE_ID }
        ]);
      }
    );
  }
);
