import type { RecordLogEntry } from '@/signed-records/record-log/record-log-format';
import {
  importChangesOf,
  rebuildPersonalState,
  PERSONAL_IMPORT_LANE,
  PersonalExportPage,
  PersonalImportBody,
  PersonalImportBuilder
} from './personal-import';
import { checkPersonalItem } from './personal-record-checks';
import { registerPersonalRecordTypes } from './personal-record-types';
import {
  FixtureOwnerDirectory,
  MemoryPersonalTables,
  RecordingLiveEffects
} from './personal-records.test-fixtures';
import {
  RecordIndexer,
  RecordRegistry,
  SenderKeyring
} from '@/signed-records/record-index';
import { byCodeUnit } from '@/signed-records/record-order';
import { MemoryHeadStore } from '@/signed-records/record-test-fixtures';

const P_ME = `0x${'0'.repeat(63)}1`;
const P_ALICE = `0x${'0'.repeat(63)}2`;

const emptyPage: PersonalExportPage = {
  follows: [],
  waveGroups: [],
  ownWavesUnfollowed: [],
  ownDropsUnfollowed: [],
  mutes: [],
  blocks: [],
  hidden: [],
  bookmarks: [],
  alerts: [],
  pins: [],
  preferences: [],
  aliases: [],
  aliasMembers: [],
  push: [],
  eula: [],
  moderationLog: [],
  collectRules: [],
  collectOperations: []
};

const follow = (
  target_type: string,
  target_id: string,
  target_action: string,
  extra: Record<string, unknown> = {}
) => ({
  subscriber_id: 'me',
  target_id,
  target_type,
  target_action,
  subscribed_to_all_drops: 0,
  own_target: 0,
  own_is_dm: 0,
  ...extra
});

async function build(page: Partial<PersonalExportPage>) {
  const owners = new Map([
    ['me', P_ME],
    ['alice', P_ALICE]
  ]);
  const lookups: string[][] = [];
  const emitted: RecordLogEntry[] = [];
  const builder = new PersonalImportBuilder({
    anchor: 1000,
    at: 5000,
    ownersOf: async (ids) => {
      lookups.push([...ids].sort(byCodeUnit));
      return new Map(
        ids.filter((id) => owners.has(id)).map((id) => [id, owners.get(id)!])
      );
    },
    check: checkPersonalItem,
    emit: async (entries) => {
      emitted.push(...entries);
    }
  });
  await builder.addPage({ ...emptyPage, ...page });
  const result = await builder.finish();
  const bodies = emitted.map(
    (entry) => (entry as { body: unknown }).body as PersonalImportBody
  );
  return { emitted, bodies, result, lookups };
}

describe('PersonalImportBuilder', () => {
  it('puts follows of people in public, follows of waves and drops sealed, and resolves owners once per page', async () => {
    const { emitted, bodies, result, lookups } = await build({
      follows: [
        follow('IDENTITY', 'alice', 'DROP_REPLIED'),
        follow('IDENTITY', 'alice', 'DROP_CREATED'),
        follow('WAVE', 'wave-1', 'DROP_CREATED', {
          subscribed_to_all_drops: 1
        }),
        follow('DROP', 'drop-1', 'DROP_REPLIED')
      ],
      waveGroups: [
        { identity_id: 'me', wave_id: 'wave-1', mentioned_group: 'ALL' }
      ],
      mutes: [{ muter_id: 'me', muted_identity_id: 'alice', created_at: '42' }]
    });
    expect(lookups).toEqual([['alice', 'me']]);
    expect(
      emitted.map((entry) => [entry.lane, (entry as { chain: string }).chain])
    ).toEqual([
      [PERSONAL_IMPORT_LANE, 'public'],
      [PERSONAL_IMPORT_LANE, 'private'],
      [PERSONAL_IMPORT_LANE, 'public']
    ]);
    expect(bodies[0]).toEqual({
      v: 1,
      anchor: 1000,
      at: 5000,
      owner: P_ME,
      family: 'ps',
      items: [
        {
          t: 'follow',
          k: `identity:${P_ALICE}`,
          // In row order, as the API lists them.
          b: { actions: ['DROP_REPLIED', 'DROP_CREATED'] }
        }
      ]
    });
    expect(bodies[1].items).toEqual([
      { t: 'follow', k: 'wave:wave-1', b: { actions: ['DROP_CREATED'] } },
      { t: 'follow', k: 'drop:drop-1', b: { actions: ['DROP_REPLIED'] } },
      {
        t: 'wave-notify',
        k: 'wave-1',
        b: { all_drops: true, groups: ['ALL'] }
      },
      { t: 'mute', k: P_ALICE, b: { at: 42 } }
    ]);
    // The closing entry names the count, so a rebuild takes no partial import.
    expect(bodies[2]).toEqual({
      v: 1,
      anchor: 1000,
      at: 5000,
      done: true,
      entries: 2
    });
    expect(result).toEqual({ entries: 2, skipped: {} });
  });

  it("leaves one's own waves and drops to the waves index, and unsets those removed", async () => {
    const { bodies } = await build({
      follows: [
        follow('DROP', 'my-drop', 'DROP_REPLIED', { own_target: 1 }),
        follow('WAVE', 'my-dm', 'DROP_CREATED', {
          own_target: 1,
          own_is_dm: 1,
          subscribed_to_all_drops: 1
        })
      ],
      waveGroups: [
        { identity_id: 'me', wave_id: 'my-dm', mentioned_group: 'ALL' }
      ],
      ownDropsUnfollowed: [{ id: 'old-drop', author_id: 'me' }],
      ownWavesUnfollowed: [{ id: 'old-wave', created_by: 'me' }]
    });
    // A creator's DM wave at its defaults needs no item.
    expect(bodies[0].items).toEqual([
      { t: 'follow', k: 'wave:old-wave', b: null },
      { t: 'follow', k: 'drop:old-drop', b: null }
    ]);
  });

  it("leaves out default preferences, a follow's default groups and anonymous EULA consents", async () => {
    const { bodies } = await build({
      follows: [follow('WAVE', 'wave-1', 'DROP_CREATED')],
      waveGroups: [
        { identity_id: 'me', wave_id: 'wave-1', mentioned_group: 'ALL' }
      ],
      preferences: [
        {
          profile_id: 'me',
          direct_message_policy: 'EVERYONE',
          direct_message_group_id: null,
          direct_message_allow_people_i_follow: 1,
          notification_level: 'ALL',
          notify_direct_messages: 1,
          notify_mentions_replies_quotes: 1,
          notify_reactions_votes_boosts: 0,
          notify_new_followers: 1,
          notify_rep_and_nic: 1,
          notify_subscription_coverage: 1
        }
      ],
      eula: [
        {
          device_id: 'anonymous-device',
          platform: 'ios',
          accepted_at: 1,
          eula_version: '1',
          profile_id: null
        }
      ]
    });
    expect(bodies[0].items).toEqual([
      { t: 'follow', k: 'wave:wave-1', b: { actions: ['DROP_CREATED'] } },
      { t: 'pref', k: 'notify.reactions_votes_boosts', b: { on: false } }
    ]);
  });

  it('skips and counts an item its type refuses, keeping the rest of the entry', async () => {
    const { bodies, result } = await build({
      preferences: [
        {
          profile_id: 'me',
          direct_message_policy: 'GROUP_MEMBERS',
          // Longer than any group id the column holds.
          direct_message_group_id: 'g'.repeat(201),
          direct_message_allow_people_i_follow: 1,
          notification_level: 'ALL',
          notify_direct_messages: 1,
          notify_mentions_replies_quotes: 1,
          notify_reactions_votes_boosts: 1,
          notify_new_followers: 1,
          notify_rep_and_nic: 1,
          notify_subscription_coverage: 1
        }
      ],
      mutes: [{ muter_id: 'me', muted_identity_id: 'alice', created_at: 1 }],
      blocks: [
        {
          blocker_profile_id: 'me',
          blocked_profile_id: 'nobody',
          created_at: 1
        }
      ]
    });
    expect(bodies[0].items).toEqual([{ t: 'mute', k: P_ALICE, b: { at: 1 } }]);
    expect(result.skipped).toEqual({
      'no owner': 1,
      'pref: A dm preference is {policy: EVERYONE|PEOPLE_I_FOLLOW|NOBODY|GROUP_MEMBERS, group_id, allow_people_i_follow}': 1
    });
  });

  it('gives pins without a saved position the next ones, and keeps an alias id', async () => {
    const { bodies } = await build({
      pins: [
        { profile_id: 'me', wave_id: 'b', position: null },
        { profile_id: 'me', wave_id: 'a', position: 4 }
      ],
      aliases: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          owner_profile_id: 'me',
          alias: 'friends'
        }
      ],
      aliasMembers: [
        {
          alias_id: '11111111-1111-4111-8111-111111111111',
          member_profile_id: 'alice',
          position: 0
        }
      ]
    });
    expect(bodies[0].items).toEqual([
      { t: 'pin', k: 'a', b: { pos: 4 } },
      { t: 'pin', k: 'b', b: { pos: 5 } },
      {
        t: 'alias',
        k: 'friends',
        b: { members: [P_ALICE], id: '11111111-1111-4111-8111-111111111111' }
      }
    ]);
  });

  it('carries each Collect rule as stored and its bindings, sealed', async () => {
    const ruleId = '00000000-0000-4000-8000-0000000000c1';
    const rule = { id: ruleId, revision: 3, state: 'ACTIVE' };
    const { bodies, emitted, result } = await build({
      collectRules: [
        {
          id: ruleId,
          profile_id: 'me',
          idempotency_key: 'key-1',
          request_hash: 'a'.repeat(64),
          payload_json: JSON.stringify(rule)
        }
      ],
      collectOperations: [
        {
          operation_id: 'op-1',
          rule_id: ruleId,
          review_hash: 'b'.repeat(64),
          settlement_hash: null,
          transaction_hash: `0x${'c'.repeat(64)}`,
          transaction_nonce: '3',
          created_at: '7'
        },
        {
          operation_id: 'op-2',
          rule_id: 'a-rule-not-on-this-page',
          review_hash: 'b'.repeat(64),
          settlement_hash: null,
          transaction_hash: null,
          transaction_nonce: null,
          created_at: 8
        }
      ]
    });
    expect((emitted[0] as { chain: string }).chain).toBe('private');
    expect(bodies[0]).toMatchObject({ owner: P_ME, family: 'pv' });
    expect(bodies[0].items).toEqual([
      {
        t: 'collect.rule-state',
        k: ruleId,
        b: { rule, idempotency_key: 'key-1', request_hash: 'a'.repeat(64) }
      },
      {
        t: 'collect.op',
        k: 'op-1',
        b: {
          rule_id: ruleId,
          review_hash: 'b'.repeat(64),
          settlement_hash: null,
          transaction_hash: `0x${'c'.repeat(64)}`,
          transaction_nonce: 3,
          created_at: 7
        }
      }
    ]);
    expect(result.skipped).toEqual({
      'collect operation without its rule': 1
    });
  });

  it("splits an owner's items so no entry passes the size limit", async () => {
    const big = 'x'.repeat(1024 * 1024);
    const { bodies } = await build({
      collectRules: [1, 2, 3, 4].map((n) => ({
        id: `00000000-0000-4000-8000-00000000000${n}`,
        profile_id: 'me',
        idempotency_key: `key-${n}`,
        request_hash: 'a'.repeat(64),
        payload_json: JSON.stringify({
          id: `00000000-0000-4000-8000-00000000000${n}`,
          note: big
        })
      }))
    });
    expect(
      bodies.filter((body) => body.items).map((body) => body.items.length)
    ).toEqual([2, 2]);
  });
});

describe('importChangesOf', () => {
  it("carries a person's own block and hide history, sealed, at each row's time", async () => {
    const audit = (
      id: number,
      action: string,
      target: Record<string, unknown>,
      states: [string, string],
      created_at: number
    ) => ({
      id,
      actor_profile_id: 'me',
      action,
      target_profile_id: null,
      target_drop_id: null,
      ...target,
      previous_state: states[0],
      new_state: states[1],
      created_at
    });
    const { bodies, result } = await build({
      moderationLog: [
        audit(
          7,
          'PROFILE_BLOCKED',
          { target_profile_id: 'alice' },
          ['UNBLOCKED', 'BLOCKED'],
          100
        ),
        audit(
          8,
          'PROFILE_UNBLOCKED',
          { target_profile_id: 'alice' },
          ['BLOCKED', 'UNBLOCKED'],
          110
        ),
        audit(
          9,
          'DROP_HIDDEN',
          { target_drop_id: 'drop-1' },
          ['SHOWN', 'HIDDEN'],
          120
        ),
        // A profile with no stream owner: skipped and counted.
        audit(
          10,
          'PROFILE_BLOCKED',
          { target_profile_id: 'gone' },
          ['UNBLOCKED', 'BLOCKED'],
          130
        )
      ]
    });
    const item = (
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
    expect(bodies[0]).toMatchObject({ owner: P_ME, family: 'pv' });
    expect(bodies[0].items).toEqual([
      item('7', 'PROFILE_BLOCKED', P_ALICE, 'UNBLOCKED', 'BLOCKED', 100),
      item('8', 'PROFILE_UNBLOCKED', P_ALICE, 'BLOCKED', 'UNBLOCKED', 110),
      item('9', 'DROP_HIDDEN', 'drop-1', 'SHOWN', 'HIDDEN', 120)
    ]);
    expect(result.skipped).toEqual({ 'no owner': 1 });
  });

  it('gives every item the import order key and no event', () => {
    expect(
      importChangesOf({
        v: 1,
        anchor: 1000,
        at: 5000,
        owner: P_ME,
        family: 'pv',
        items: [{ t: 'mute', k: P_ALICE, b: { at: 42 } }]
      })
    ).toEqual([
      {
        owner: P_ME,
        family: 'pv',
        type: 'mute',
        key: P_ALICE,
        body: { at: 42 },
        order: {
          anchor: 1000,
          claimedTime: 5000,
          eventId: `0x${'0'.repeat(64)}`
        },
        eventId: null,
        sealedClass: 1,
        writer: 'author'
      }
    ]);
  });
});

describe('rebuildPersonalState with report effects', () => {
  it("applies a report's hide and block after the import, in merge order", async () => {
    const tables = new MemoryPersonalTables();
    tables.dropWaves.set('drop-1', 'wave-1');
    const owners = new FixtureOwnerDirectory(
      new Map([
        [P_ME, 'me'],
        [P_ALICE, 'alice']
      ])
    );
    const registry = registerPersonalRecordTypes(new RecordRegistry(), {
      owners,
      tables,
      live: new RecordingLiveEffects(tables)
    });
    const heads = new MemoryHeadStore();
    const lock = jest.spyOn(heads, 'lock');
    const indexer = new RecordIndexer({
      registry,
      heads,
      keyring: new SenderKeyring([])
    });
    const done = {
      v: 1 as const,
      anchor: 1000,
      at: 5000,
      done: true as const,
      entries: 0
    };
    const report = await rebuildPersonalState({
      indexer,
      heads,
      imports: [done],
      records: [],
      reportEffects: [
        {
          reporter: P_ME,
          dropId: 'drop-1',
          author: P_ALICE,
          hideDrop: true,
          blockAuthor: true,
          order: {
            anchor: 1001,
            claimedTime: 6000,
            eventId: `0x${'a'.repeat(64)}`
          }
        },
        {
          // Before the import: the import holds what it left.
          reporter: P_ME,
          dropId: 'drop-2',
          author: null,
          hideDrop: true,
          blockAuthor: null,
          order: {
            anchor: 999,
            claimedTime: 4000,
            eventId: `0x${'b'.repeat(64)}`
          }
        }
      ],
      ctx: {}
    });
    expect(report.refused).toEqual([]);
    expect(Array.from(tables.hidden.entries())).toEqual([['me|drop-1', 6000]]);
    expect(Array.from(tables.blocks.keys())).toEqual(['me|alice']);
    // Live applies report effects outside the indexer: no head, no lock.
    expect(heads.heads.size).toBe(0);
    expect(lock).not.toHaveBeenCalled();
  });
});
