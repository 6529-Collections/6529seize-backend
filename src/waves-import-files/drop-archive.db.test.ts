import { dropsService } from '@/api/drops/drops.api.service';
import { ApiDropSearchStrategy } from '@/api/generated/models/ApiDropSearchStrategy';
import { AuthenticationContext } from '@/auth-context';
import { DROPS_PARTS_TABLE, DROPS_TABLE } from '@/constants';
import { NotFoundException } from '@/exceptions';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import {
  FIXTURE_DROPS,
  FIXTURE_PARTS,
  FIXTURE_WAVES
} from '@/tests/fixtures/drop-archive.fixture';
import { anIdentity, withIdentities } from '@/tests/fixtures/identity.fixture';
import { withProfileGroups } from '@/tests/fixtures/profile-group.fixture';
import {
  aUserGroup,
  withUserGroups
} from '@/tests/fixtures/user-group.fixture';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import {
  buildDropArchives,
  wavesFileFor
} from '@/waves-import-files/drop-archive.build';
import { keccak256Hex } from '@/waves-import-files/drop-archive.format';
import { importDropArchives } from '@/waves-import-files/drop-archive.reader';
import { dbDropArchiveWriter } from '@/waves-import-files/drop-archive.sources';

/**
 * The reader against MySQL and 6529.io's own drop reads: the rows it writes
 * are the archive's exactly, and a members-only wave's drops stay readable
 * by a member only. Wave A is members-only, wave B public; all ids made up.
 */
const CREATOR = '33333333-3333-4333-8333-000000000001';
const MEMBER = '33333333-3333-4333-8333-000000000002';
const OUTSIDER = '33333333-3333-4333-8333-000000000003';
const MEMBERS_PROFILE_GROUP = '55555555-5555-4555-8555-000000000001';

const membersGroup = aUserGroup(
  {
    profile_group_id: MEMBERS_PROFILE_GROUP,
    is_private: true,
    is_direct_message: false,
    created_by: CREATOR
  },
  { id: 'import-files-members', name: 'Import files members' }
);

const identity = (profileId: string, n: number) =>
  anIdentity(
    {},
    {
      profile_id: profileId,
      consolidation_key: `0x${String(n).repeat(40)}`,
      primary_address: `0x${String(n).repeat(40)}`,
      handle: `importfiles${n}`
    }
  );

function signedIn(profileId: string, n: number): AuthenticationContext {
  return new AuthenticationContext({
    authenticatedWallet: `0x${String(n).repeat(40)}`,
    authenticatedProfileId: profileId,
    roleProfileId: null,
    activeProxyActions: []
  });
}

async function importFixture(drops = FIXTURE_DROPS) {
  const built = buildDropArchives(drops, FIXTURE_PARTS);
  const wavesFile = wavesFileFor(built);
  const archives: Record<string, Uint8Array> = {};
  built.archives.forEach((archive) => {
    archives[archive.waveId] = archive.bytes;
  });
  return importDropArchives({
    chain: { importedFileHash: async () => keccak256Hex(wavesFile) },
    files: {
      wavesFile: async () => wavesFile,
      archiveIndex: async () => built.index,
      archive: async (waveId) => archives[waveId] ?? null
    },
    writer: dbDropArchiveWriter(sqlExecutor)
  });
}

function feed(waveId: string, authenticationContext: AuthenticationContext) {
  return dropsService.findWaveDropsFeed(
    {
      drop_id: null,
      wave_id: waveId,
      serial_no_limit: null,
      amount: 20,
      search_strategy: ApiDropSearchStrategy.Older,
      drop_type: null,
      curation_id: null
    },
    { authenticationContext }
  );
}

describeWithSeed(
  'the drop archive reader on MySQL',
  [
    withIdentities([
      identity(CREATOR, 1),
      identity(MEMBER, 2),
      identity(OUTSIDER, 3)
    ]),
    withUserGroups([membersGroup]),
    withProfileGroups([
      { profile_group_id: MEMBERS_PROFILE_GROUP, profile_id: MEMBER }
    ]),
    withWaves([
      aWave(
        {
          created_by: CREATOR,
          visibility_group_id: membersGroup.id,
          chat_group_id: membersGroup.id,
          description_drop_id: FIXTURE_DROPS[0].id
        },
        { id: FIXTURE_WAVES.a, name: 'Import files members wave', serial_no: 1 }
      ),
      aWave(
        { created_by: CREATOR, description_drop_id: FIXTURE_DROPS[3].id },
        { id: FIXTURE_WAVES.b, name: 'Import files public wave', serial_no: 2 }
      )
    ])
  ],
  () => {
    it("writes the archive's drops and parts exactly", async () => {
      const report = await importFixture();
      expect(report.refused).toEqual([]);
      expect(report).toMatchObject({ written: 2, drops: 4, parts: 5 });
      const drops = await sqlExecutor.execute<Record<string, unknown>>(
        `select id, serial_no, wave_id, author_id, created_at, updated_at, title,
           parts_count, reply_to_drop_id, reply_to_part_id, drop_type, signature,
           is_additional_action_promised, hide_link_preview, collapse_replies
         from ${DROPS_TABLE} order by serial_no`
      );
      expect(
        drops.map((d) => ({
          ...d,
          // MySQL gives booleans as 0 and 1, bigints as numbers here.
          hide_link_preview: !!d.hide_link_preview,
          collapse_replies: !!d.collapse_replies
        }))
      ).toEqual(
        [...FIXTURE_DROPS]
          .sort((a, b) => a.serial_no - b.serial_no)
          .map((d) => ({
            ...d,
            parts_count: FIXTURE_PARTS.filter((p) => p.drop_id === d.id).length,
            // The API's values the archive holds.
            drop_type:
              d.drop_type === 'COMPETITION' ? 'PARTICIPATORY' : d.drop_type,
            reply_to_part_id: d.reply_to_drop_id
              ? (d.reply_to_part_id ?? 0)
              : null,
            signature: null,
            is_additional_action_promised: null,
            hide_link_preview: false,
            collapse_replies: false
          }))
      );
      const parts = await sqlExecutor.execute<Record<string, unknown>>(
        `select drop_id, drop_part_id, content, quoted_drop_id, quoted_drop_part_id, wave_id
         from ${DROPS_PARTS_TABLE} order by drop_id, drop_part_id`
      );
      expect(parts).toEqual(
        [...FIXTURE_PARTS].sort(
          (a, b) =>
            a.drop_id.localeCompare(b.drop_id) ||
            a.drop_part_id - b.drop_part_id
        )
      );
    });

    it('writes a negative serial as 6529.io holds a few', async () => {
      const report = await importFixture(
        FIXTURE_DROPS.map((d, i) => (i === 0 ? { ...d, serial_no: -3 } : d))
      );
      expect(report.refused).toEqual([]);
      const [row] = await sqlExecutor.execute<{ serial_no: number }>(
        `select serial_no from ${DROPS_TABLE} where id = :id`,
        { id: FIXTURE_DROPS[0].id }
      );
      expect(Number(row.serial_no)).toBe(-3);
    });

    it("keeps a members-only wave's drops to its members through 6529.io's reads", async () => {
      // A winner drop's read needs its decision's rows, which this test
      // has no part in: the public wave's drop is chat here.
      await importFixture(
        FIXTURE_DROPS.map((d) =>
          d.drop_type === 'WINNER' ? { ...d, drop_type: 'CHAT' } : d
        )
      );
      const members = FIXTURE_DROPS.filter((d) => d.wave_id === FIXTURE_WAVES.a)
        .map((d) => d.id)
        .sort();
      const asMember = await feed(FIXTURE_WAVES.a, signedIn(MEMBER, 2));
      expect(asMember.drops.map((d) => d.id).sort()).toEqual(members);
      expect(
        (
          await dropsService.findDropByIdOrThrow(
            { dropId: members[0] },
            { authenticationContext: signedIn(MEMBER, 2) }
          )
        ).id
      ).toBe(members[0]);
      for (const reader of [
        AuthenticationContext.notAuthenticated(),
        signedIn(OUTSIDER, 3)
      ]) {
        await expect(feed(FIXTURE_WAVES.a, reader)).rejects.toBeInstanceOf(
          NotFoundException
        );
        await expect(
          dropsService.findDropByIdOrThrow(
            { dropId: members[0] },
            { authenticationContext: reader }
          )
        ).rejects.toBeInstanceOf(NotFoundException);
      }
      // The public wave's drop is readable signed out.
      const signedOut = await feed(
        FIXTURE_WAVES.b,
        AuthenticationContext.notAuthenticated()
      );
      expect(signedOut.drops.map((d) => d.id)).toEqual([FIXTURE_DROPS[3].id]);
    });
  }
);
