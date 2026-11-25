import 'reflect-metadata';
import {
  ADDRESS_CONSOLIDATION_KEY,
  IDENTITIES_TABLE,
  PROFILES_TABLE
} from '@/constants';
import {
  ALL_WORLD_ACTORS,
  PROBE_WALLETS,
  SUBS_WIDE_LABELS,
  worldActorIdentity,
  worldActorWallet
} from '@/rebuild/manifests/probe-fixture';
import {
  importedPrincipalId,
  principalByProfileId,
  probeProfileId,
  profileIdByWallet,
  seedProbeIdentities
} from '@/rebuild/run/probe-fixture.steps';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { writeWorldActorsForTests } from '@/tests/fixtures/world-actors.fixture';

describeWithSeed("the world's actors, read by wallet", [], () => {
  it("finds each actor the tests' stand-in writes, with its principal", async () => {
    await writeWorldActorsForTests(ALL_WORLD_ACTORS, { principals: true });
    for (const actor of ALL_WORLD_ACTORS) {
      const { profileId, wallets } = worldActorIdentity(actor);
      for (const wallet of wallets) {
        await expect(profileIdByWallet(wallet)).resolves.toBe(profileId);
      }
      await expect(principalByProfileId(profileId)).resolves.toBe(
        importedPrincipalId(profileId)
      );
    }
    await expect(probeProfileId(1)).resolves.toBe(
      '00000000-0000-4000-8000-000000000101'
    );
  });

  it('keeps subs-wide one identity, its 644-character key whole', async () => {
    await writeWorldActorsForTests(['subs-wide']);
    const rows = await sqlExecutor.execute<{ consolidation_key: string }>(
      `select consolidation_key from ${IDENTITIES_TABLE}`
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].consolidation_key).toHaveLength(644);
    await expect(
      profileIdByWallet(worldActorWallet(SUBS_WIDE_LABELS[14]))
    ).resolves.toBe('00000000-0000-4000-8000-0000000001d0');
  });

  it('writes no principal unless asked, and names a wallet nothing holds', async () => {
    await writeWorldActorsForTests(['dm-e2ee-a']);
    await expect(
      principalByProfileId('00000000-0000-4000-8000-0000000001e1')
    ).rejects.toThrow('has no chain principal');
    await expect(
      profileIdByWallet(worldActorWallet('dm-e2ee-b'))
    ).rejects.toThrow('(dm-e2ee-b)');
  });

  it("fails when another seed wrote an identity for an actor's wallet", async () => {
    await sqlExecutor.execute(
      `insert into ${IDENTITIES_TABLE}
         (consolidation_key, profile_id, primary_address, handle,
          normalised_handle, tdh, rep, cic, level_raw, classification,
          xtdh, produced_xtdh, granted_xtdh, xtdh_rate, basetdh_rate)
       values (:wallet, 'rebuild-probe-1', :wallet, 'rebuild-probe-1',
          'rebuild-probe-1', 0, 0, 0, 0, 'PSEUDONYM', 0, 0, 0, 0, 0)`,
      { wallet: PROBE_WALLETS[0] }
    );
    await sqlExecutor.execute(
      `insert into ${ADDRESS_CONSOLIDATION_KEY} (address, consolidation_key)
       values (:wallet, :wallet)`,
      { wallet: PROBE_WALLETS[0] }
    );
    await expect(writeWorldActorsForTests(['probe-1'])).rejects.toThrow(
      `probe-1: wallet ${PROBE_WALLETS[0]} is held by profile rebuild-probe-1`
    );
  });

  it("fails when another seed wrote a profile with an actor's handle", async () => {
    await sqlExecutor.execute(
      `insert into ${PROFILES_TABLE}
         (external_id, handle, normalised_handle, primary_wallet, created_at,
          created_by_wallet)
       values ('rebuild-records-service', 'rebuild_records',
          'rebuild_records', :wallet, :created, :wallet)`,
      { wallet: '0x' + 'a1'.repeat(20), created: new Date(0) }
    );
    await expect(writeWorldActorsForTests(['records-service'])).rejects.toThrow(
      'records-service: handle rebuild_records belongs to profile rebuild-records-service'
    );
  });

  it('seeds the fallback world, and can run again', async () => {
    await seedProbeIdentities();
    await seedProbeIdentities();
    await expect(probeProfileId(2)).resolves.toBe(
      '00000000-0000-4000-8000-000000000102'
    );
    await expect(
      principalByProfileId(
        await profileIdByWallet(worldActorWallet('live-owner'))
      )
    ).resolves.toBe(
      importedPrincipalId('00000000-0000-4000-8000-0000000000b1')
    );
  });
});
