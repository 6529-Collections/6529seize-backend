import 'reflect-metadata';
import {
  ADDRESS_CONSOLIDATION_KEY,
  IDENTITIES_TABLE,
  IDENTITY_CHAIN_PRINCIPALS_TABLE
} from '@/constants';
import { ChainIdentity } from '@/chain-gateway/chain-gateway.types';
import { identitiesDb } from '@/identities/identities.db';
import { identityConsolidationEffects } from '@/identity';
import { dbSupplier, sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { anIdentity } from '@/tests/fixtures/identity.fixture';
import { IdentityChainMirrorDb } from './identity-chain-mirror.db';
import { ProfileIds } from './profile-ids';
import { consolidatedTdhRow } from './rebuild-world/consolidated-tdh-row';
import {
  beforeSwitchOn,
  insertConsolidatedTdh
} from './rebuild-world/site-rows';
import { loadSwitchOnRecord, takeSwitchOnRecord } from './switch-on-record';
import { formatTdhOnlyRecord, parseTdhOnlyRecord } from './tdh-only-record';

const W = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
/** A wallet with TDH and no profile: step B makes its row. */
const TDH_ONLY = W(0x901);
/** A wallet a user group named: an address-only row; a chain identity takes it. */
const GROUPED = W(0x902);
/** A placeholder's wallet: its row has a handle, so the record leaves it. */
const PLACEHOLDER = W(0x903);
/** A handle-less row a principal maps already: the record leaves it. */
const MAPPED = W(0x904);
const MAPPED_ID = '00000000-0000-4000-8000-000000000904';
const PRINCIPAL = `0x${'9a'.repeat(32)}`;
const OTHER_PRINCIPAL = `0x${'9b'.repeat(32)}`;

type Row = Record<string, unknown>;

async function rowsOf(keys: readonly string[]): Promise<{
  identities: Row[];
  keys: Row[];
}> {
  return {
    identities: await sqlExecutor.execute<Row>(
      `select * from ${IDENTITIES_TABLE} where consolidation_key in (:keys)
       order by consolidation_key`,
      { keys }
    ),
    keys: await sqlExecutor.execute<Row>(
      `select * from ${ADDRESS_CONSOLIDATION_KEY} where consolidation_key in (:keys)
       order by address`,
      { keys }
    )
  };
}

/** An identity made on the chain after the import, on the given wallets. */
function madeOnChain(wallets: string[]): ChainIdentity {
  return {
    principalId: PRINCIPAL,
    kind: 'person',
    status: 'active',
    createdHeight: 20,
    handle: 'grouped_then_chain',
    anchor: wallets[0],
    primary: wallets[0],
    primarySource: 'anchor',
    wallets,
    profile: null,
    rep: { total: '0', raters: 0 },
    nic: { total: '0', raters: 0 },
    level: null,
    legacyId: null
  } as unknown as ChainIdentity;
}

describeWithSeed(
  'the switch-on record, taken and loaded',
  [
    {
      table: IDENTITIES_TABLE,
      rows: [
        anIdentity(
          {},
          {
            consolidation_key: PLACEHOLDER,
            profile_id: '00000000-0000-4000-8000-000000000903',
            primary_address: PLACEHOLDER,
            handle: `id-${PLACEHOLDER}`
          }
        ),
        {
          ...anIdentity(
            {},
            {
              consolidation_key: MAPPED,
              profile_id: MAPPED_ID,
              primary_address: MAPPED,
              handle: 'unused'
            }
          ),
          handle: null,
          normalised_handle: null
        }
      ]
    },
    {
      table: ADDRESS_CONSOLIDATION_KEY,
      rows: [PLACEHOLDER, MAPPED].map((address) => ({
        address,
        consolidation_key: address
      }))
    },
    {
      table: IDENTITY_CHAIN_PRINCIPALS_TABLE,
      rows: [
        {
          principal_id: OTHER_PRINCIPAL,
          profile_id: MAPPED_ID,
          origin: 'imported',
          created_at: 1
        }
      ]
    }
  ],
  () => {
    it("loads back production's rows, and the mirror adopts the record's id on an equal key", async () => {
      // 6529.io before switch-on: step B makes the TDH-only row, a user
      // group makes the address-only one, each with a random id.
      await beforeSwitchOn(async () => {
        await insertConsolidatedTdh([consolidatedTdhRow(TDH_ONLY, 400)]);
        await dbSupplier().executeNativeQueriesInTransaction((connection) =>
          identityConsolidationEffects.syncIdentitiesWithTdhConsolidations(
            connection
          )
        );
        await dbSupplier().executeNativeQueriesInTransaction((connection) =>
          identitiesDb.insertIdentitiesOnAddressesOnly([GROUPED], connection)
        );
      });

      // The team's take: those two rows and their keys, not the
      // placeholder's (a handle) or the mapped one (a principal).
      const taken = await takeSwitchOnRecord();
      expect(taken.rows.map((it) => it.consolidation_key)).toEqual([
        TDH_ONLY,
        GROUPED
      ]);
      expect(taken.rows[0]).toMatchObject({ tdh: 400, level_raw: 400 });
      expect(taken.keys).toEqual([
        { address: TDH_ONLY, consolidation_key: TDH_ONLY },
        { address: GROUPED, consolidation_key: GROUPED }
      ]);
      const groupedId = taken.rows[1].profile_id;
      expect(groupedId).toMatch(/^[0-9a-f-]{36}$/);
      const before = await rowsOf([TDH_ONLY, GROUPED]);

      // Through the files and back, onto empty tables, as a rebuild loads it.
      const formatted = formatTdhOnlyRecord(taken.rows, taken.keys);
      const record = parseTdhOnlyRecord(
        formatted.identitiesTsv,
        formatted.keysTsv,
        formatted
      );
      await sqlExecutor.execute(
        `delete from ${IDENTITIES_TABLE} where consolidation_key in (:keys)`,
        { keys: [TDH_ONLY, GROUPED] }
      );
      await sqlExecutor.execute(
        `delete from ${ADDRESS_CONSOLIDATION_KEY} where consolidation_key in (:keys)`,
        { keys: [TDH_ONLY, GROUPED] }
      );
      expect(await loadSwitchOnRecord(record)).toEqual({
        identities: 2,
        keys: 2
      });
      // Every column as production left it.
      expect(await rowsOf([TDH_ONLY, GROUPED])).toEqual(before);

      // An identity made on the chain on the grouped wallet alone: the
      // mirror's id for it is the record's, the id 6529.io issued.
      const ids = new ProfileIds(
        {} as any,
        new IdentityChainMirrorDb(() => sqlExecutor),
        () => Date.parse('2026-11-29T01:00:00Z')
      );
      ids.setImportHeights(1, 10);
      expect(await ids.profileIdOf(madeOnChain([GROUPED]))).toBe(groupedId);
    });
  }
);
