import {
  ApplyMode,
  RecordChange,
  RecordRegistry,
  RecordRuleError
} from '@/signed-records/record-index';
import { CURRENT_EULA_VERSION } from '@/api/policies/eula-policy';
import {
  mentionAliasId,
  PersonalRecordType,
  registerPersonalRecordTypes
} from './personal-record-types';
import {
  FixtureOwnerDirectory,
  MemoryPersonalTables,
  RecordingLiveEffects
} from './personal-records.test-fixtures';

const ME = `0x${'0'.repeat(63)}1`;
const ALICE = `0x${'0'.repeat(63)}2`;
const BOB = `0x${'0'.repeat(63)}3`;
const UNBOUND_WALLET = `0x${'4'.repeat(40)}`;
const BOUND_WALLET = `0x${'5'.repeat(40)}`;
const NOBODY = `0x${'0'.repeat(63)}9`;
const WAVE = 'wave-1';
const DROP = 'drop-1';
const AT = 1_795_694_700_000;

/** Only follows of people are public; wave and drop follows are sealed. */
const isSealed = (type: string, key: string) =>
  type !== PersonalRecordType.FOLLOW || /^(wave|drop):/.test(key);

function setup() {
  const tables = new MemoryPersonalTables();
  tables.waves.add(WAVE);
  tables.dropWaves.set(DROP, WAVE);
  tables.mentionable.add('p-alice');
  tables.mentionable.add('p-bob');
  const owners = new FixtureOwnerDirectory(
    new Map([
      [ME, 'p-me'],
      [ALICE, 'p-alice'],
      [BOB, 'p-bob'],
      [UNBOUND_WALLET, 'p-wallet']
    ]),
    [{ wallet: BOUND_WALLET, principal: BOB, from: 1 }]
  );
  const live = new RecordingLiveEffects(tables);
  const registry = registerPersonalRecordTypes(new RecordRegistry(), {
    owners,
    tables,
    live
  });
  let seq = 0;
  const run = async (
    type: string,
    key: string,
    body: Record<string, unknown> | null,
    mode: ApplyMode = 'live',
    owner = ME
  ) => {
    const sealed = isSealed(type, key);
    const handler = registry.find(sealed ? 'pv' : 'ps', type, sealed);
    if (!handler) throw new Error(`no handler for ${type}`);
    seq++;
    const change: RecordChange = {
      owner,
      family: sealed ? 'pv' : 'ps',
      type,
      key,
      body,
      order: {
        anchor: 1000 + seq,
        claimedTime: AT + seq,
        eventId: `0x${seq.toString(16).padStart(64, '0')}`
      },
      eventId: `0x${seq.toString(16).padStart(64, '0')}`,
      sealedClass: sealed ? 1 : null,
      writer: 'author'
    };
    handler.validate(change);
    await handler.apply(change, mode, {});
    return change;
  };
  const invalid = (
    type: string,
    key: string,
    body: Record<string, unknown> | null,
    imported = false
  ) => {
    const sealed = isSealed(type, key);
    const handler = registry.find(sealed ? 'pv' : 'ps', type, sealed)!;
    return () =>
      handler.validate({
        owner: ME,
        family: sealed ? 'pv' : 'ps',
        type,
        key,
        body,
        order: { anchor: 1, claimedTime: 1, eventId: '0x00' },
        eventId: imported ? null : `0x${'1'.repeat(64)}`,
        sealedClass: null,
        writer: 'author'
      });
  };
  return { tables, owners, live, registry, run, invalid };
}

async function ruleCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RecordRuleError) return error.code;
    throw error;
  }
  return 'none';
}

describe('personal record types', () => {
  it('registers the twelve types, follows both public and sealed', () => {
    const { registry } = setup();
    for (const type of Object.values(PersonalRecordType)) {
      expect(registry.find('pv', type, true)).not.toBeNull();
    }
    expect(
      registry.find('ps', PersonalRecordType.FOLLOW, false)
    ).not.toBeNull();
  });

  it("answers 503 when the gateway can't say whose a target wallet is", async () => {
    const { run, owners } = setup();
    jest
      .spyOn(owners, 'principalAt')
      .mockRejectedValue(new Error('does not cover height'));
    await expect(run('mute', UNBOUND_WALLET, {})).rejects.toMatchObject({
      code: 'OWNERS_UNAVAILABLE'
    });
  });

  describe('follow', () => {
    it('sets the full set of actions, notifies a new follower once, and unfollows', async () => {
      const { run, tables, live } = setup();
      await run('follow', `identity:${ALICE}`, { actions: ['DROP_CREATED'] });
      await run('follow', `identity:${ALICE}`, {
        actions: ['DROP_CREATED', 'WAVE_CREATED']
      });
      expect(await tables.followActions('p-me', 'IDENTITY', 'p-alice')).toEqual(
        ['DROP_CREATED', 'WAVE_CREATED']
      );
      expect(live.calls).toEqual(['new-follower p-me->p-alice']);
      await run('follow', `identity:${ALICE}`, { actions: ['WAVE_CREATED'] });
      expect(await tables.followActions('p-me', 'IDENTITY', 'p-alice')).toEqual(
        ['WAVE_CREATED']
      );
      await run('follow', `identity:${ALICE}`, null);
      expect(tables.follows.size).toBe(0);
    });

    it('takes an unbound wallet, and refuses a bound wallet named instead of its principal', async () => {
      const { run, tables } = setup();
      await run('follow', `identity:${UNBOUND_WALLET}`, {
        actions: ['DROP_CREATED']
      });
      expect(
        await tables.followActions('p-me', 'IDENTITY', 'p-wallet')
      ).toEqual(['DROP_CREATED']);
      expect(
        await ruleCode(
          run('follow', `identity:${BOUND_WALLET}`, {
            actions: ['DROP_CREATED']
          })
        )
      ).toBe('TARGET_NOT_CANONICAL');
    });

    it("refuses a follow of a profile you block, live; a rebuild doesn't check", async () => {
      const { run, tables } = setup();
      await run('block', ALICE, {});
      expect(
        await ruleCode(
          run('follow', `identity:${ALICE}`, { actions: ['DROP_CREATED'] })
        )
      ).toBe('BLOCKED');
      await run(
        'follow',
        `identity:${ALICE}`,
        { actions: ['DROP_CREATED'] },
        'rebuild'
      );
      expect(await tables.followActions('p-me', 'IDENTITY', 'p-alice')).toEqual(
        ['DROP_CREATED']
      );
    });

    it('follows a wave with its default groups and a socket event, and unfollows', async () => {
      const { run, tables, live } = setup();
      await run('follow', `wave:${WAVE}`, { actions: ['DROP_CREATED'] });
      expect(await tables.waveFollowState('p-me', WAVE)).toEqual({
        isFollowing: true,
        allDrops: false
      });
      expect(tables.waveGroups.get(`p-me|${WAVE}`)).toEqual(['ALL']);
      await run('follow', `wave:${WAVE}`, null);
      expect(tables.waveGroups.has(`p-me|${WAVE}`)).toBe(false);
      expect(live.calls).toEqual([
        'active p-me',
        `score ${WAVE}`,
        `FOLLOWED p-me ${WAVE}`,
        'active p-me',
        `score ${WAVE}`,
        `UNFOLLOWED p-me ${WAVE}`
      ]);
      expect(
        await ruleCode(
          run('follow', 'wave:missing', { actions: ['DROP_CREATED'] })
        )
      ).toBe('WAVE_NOT_FOUND');
    });

    it("follows a drop with its wave, and a rebuild skips a drop that's gone", async () => {
      const { run, tables } = setup();
      await run('follow', `drop:${DROP}`, { actions: ['DROP_REPLIED'] });
      expect(tables.follows.get(`p-me|DROP|${DROP}`)?.waveId).toBe(WAVE);
      await run(
        'follow',
        'drop:gone',
        { actions: ['DROP_REPLIED'] },
        'rebuild'
      );
      expect(tables.follows.has('p-me|DROP|gone')).toBe(false);
    });

    it('checks keys and actions', () => {
      const { invalid } = setup();
      expect(
        invalid('follow', 'identity:alice', { actions: ['DROP_CREATED'] })
      ).toThrow('principal id or a lowercase wallet');
      expect(
        invalid('follow', `wave:${WAVE}`, { actions: ['DROP_REPLIED'] })
      ).toThrow("follow's actions");
      expect(invalid('follow', `drop:${DROP}`, { actions: [] })).toThrow(
        "follow's actions"
      );
      expect(
        invalid('follow', `identity:${ALICE}`, {
          actions: ['DROP_CREATED', 'DROP_CREATED']
        })
      ).toThrow("follow's actions");
      expect(invalid('follow', `profile:${ALICE}`, null)).toThrow(
        'A public follow key is identity:'
      );
      expect(
        invalid('follow', `identity:${ALICE}`, {
          actions: ['DROP_CREATED'],
          extra: 1
        })
      ).toThrow('has the fields actions');
    });

    it('keeps wave and drop follows out of the public stream', () => {
      const { registry } = setup();
      const publicFollow = registry.find('ps', 'follow', false)!;
      const sealedFollow = registry.find('pv', 'follow', true)!;
      const change = (family: 'ps' | 'pv', key: string) => ({
        owner: ME,
        family,
        type: 'follow',
        key,
        body: { actions: ['DROP_CREATED'] },
        order: { anchor: 1, claimedTime: 1, eventId: '0x01' },
        eventId: '0x01',
        sealedClass: family === 'pv' ? 1 : null,
        writer: 'author' as const
      });
      expect(() => publicFollow.validate(change('ps', `wave:${WAVE}`))).toThrow(
        'A public follow key is identity:'
      );
      expect(() =>
        sealedFollow.validate(change('pv', `identity:${ALICE}`))
      ).toThrow('A sealed follow key is wave: or drop:');
      expect(() =>
        sealedFollow.validate(change('pv', `wave:${WAVE}`))
      ).not.toThrow();
    });

    it('needs a 6529.io profile live, and skips an owner without one in a rebuild', async () => {
      const { run, tables } = setup();
      expect(
        await ruleCode(
          run(
            'follow',
            `identity:${ALICE}`,
            { actions: ['DROP_CREATED'] },
            'live',
            NOBODY
          )
        )
      ).toBe('PROFILE_REQUIRED');
      await run(
        'follow',
        `identity:${ALICE}`,
        { actions: ['DROP_CREATED'] },
        'rebuild',
        NOBODY
      );
      expect(tables.follows.size).toBe(0);
    });
  });

  describe('mute, block and artwork alerts', () => {
    it("mutes and unmutes at the record's time, with today's DM unread sync", async () => {
      const { run, tables, live } = setup();
      const change = await run('mute', ALICE, {});
      expect(tables.mutes.get('p-me|p-alice')).toBe(change.order.claimedTime);
      await run('mute', ALICE, null);
      expect(tables.mutes.size).toBe(0);
      expect(live.calls).toEqual(['mute p-me->p-alice', 'mute p-me->p-alice']);
    });

    it('refuses yourself live and skips it in a rebuild', async () => {
      const { run, tables } = setup();
      expect(await ruleCode(run('mute', ME, {}))).toBe('SELF');
      await run('block', ME, {}, 'rebuild');
      expect(tables.blocks.size).toBe(0);
    });

    it("a block removes the follow, and an artwork alert can't follow a block", async () => {
      const { run, tables } = setup();
      await run('follow', `identity:${ALICE}`, { actions: ['DROP_CREATED'] });
      await run('block', ALICE, {});
      expect(tables.follows.size).toBe(0);
      expect(await ruleCode(run('art-alert', ALICE, {}))).toBe('BLOCKED');
      await run('block', ALICE, null);
      await run('art-alert', ALICE, {});
      expect(tables.alerts.has('p-me|p-alice')).toBe(true);
    });

    it('refuses an unknown target live', async () => {
      const { run } = setup();
      expect(await ruleCode(run('mute', NOBODY, {}))).toBe('TARGET_NOT_FOUND');
    });
  });

  describe('hide and bookmark', () => {
    it("sets them at the record's time, and refuses a drop the person can't read", async () => {
      const { run, tables, live } = setup();
      const change = await run('bookmark', DROP, {});
      expect(tables.bookmarks.get(`p-me|${DROP}`)).toBe(
        change.order.claimedTime
      );
      await run('hide', DROP, {});
      expect(tables.hidden.has(`p-me|${DROP}`)).toBe(true);
      live.hiddenDrops.add(DROP);
      expect(await ruleCode(run('bookmark', DROP, {}))).toBe('DROP_NOT_FOUND');
      // Unsetting needs no access.
      await run('bookmark', DROP, null);
      await run('hide', DROP, null);
      expect(tables.bookmarks.size + tables.hidden.size).toBe(0);
    });

    it('takes no body fields, except the time of imported state', () => {
      const { invalid } = setup();
      expect(invalid('hide', DROP, { at: 1 })).toThrow('has the fields none');
      expect(invalid('bookmark', 'bad id!', {})).toThrow('not an id');
      expect(invalid('hide', DROP, { at: 1 }, true)).not.toThrow();
      expect(invalid('hide', DROP, { at: -1 }, true)).toThrow('imported time');
    });
  });

  describe('pin', () => {
    it('sets a position and unpins', async () => {
      const { run, tables } = setup();
      await run('pin', WAVE, { pos: 3 });
      expect(tables.pins.get(`p-me|${WAVE}`)).toBe(3);
      await run('pin', WAVE, null);
      expect(tables.pins.size).toBe(0);
      expect(await ruleCode(run('pin', 'missing', { pos: 1 }))).toBe(
        'WAVE_NOT_FOUND'
      );
    });

    it('takes a whole-number position in range', () => {
      const { invalid } = setup();
      expect(invalid('pin', WAVE, { pos: -1 })).toThrow('whole number');
      expect(invalid('pin', WAVE, { pos: 1.5 })).toThrow('whole number');
      expect(invalid('pin', WAVE, { pos: 2_000_000 })).toThrow('whole number');
    });
  });

  describe('wave-notify', () => {
    it('takes effect only while following, as today', async () => {
      const { run, tables } = setup();
      await run('wave-notify', WAVE, {
        all_drops: true,
        groups: ['ADMINS']
      });
      expect(tables.allDrops.size + tables.waveGroups.size).toBe(0);
      await run('follow', `wave:${WAVE}`, { actions: ['DROP_CREATED'] });
      await run('wave-notify', WAVE, {
        all_drops: true,
        groups: ['DEVS_6529', 'ADMINS']
      });
      expect(await tables.waveFollowState('p-me', WAVE)).toEqual({
        isFollowing: true,
        allDrops: true
      });
      expect(tables.waveGroups.get(`p-me|${WAVE}`)).toEqual([
        'ADMINS',
        'DEVS_6529'
      ]);
      await run('wave-notify', WAVE, null);
      expect(await tables.waveFollowState('p-me', WAVE)).toEqual({
        isFollowing: true,
        allDrops: false
      });
      expect(tables.waveGroups.has(`p-me|${WAVE}`)).toBe(false);
    });

    it('checks the groups', () => {
      const { invalid } = setup();
      expect(
        invalid('wave-notify', WAVE, { all_drops: true, groups: ['EVERYONE'] })
      ).toThrow('wave-notify is');
      expect(
        invalid('wave-notify', WAVE, { all_drops: 'yes', groups: [] })
      ).toThrow('wave-notify is');
    });
  });

  describe('pref', () => {
    it('sets the DM policy, the level and one category, and their defaults', async () => {
      const { run, tables, live } = setup();
      live.selectableGroups.add('group-1');
      await run('pref', 'dm', {
        policy: 'GROUP_MEMBERS',
        group_id: 'group-1',
        allow_people_i_follow: false
      });
      await run('pref', 'level', { value: 'ESSENTIAL_ONLY' });
      await run('pref', 'notify.new_followers', { on: false });
      expect(tables.preferences.get('p-me')).toMatchObject({
        direct_message_policy: 'GROUP_MEMBERS',
        direct_message_group_id: 'group-1',
        direct_message_allow_people_i_follow: false,
        notification_level: 'ESSENTIAL_ONLY',
        notifications: { new_followers: false, direct_messages: true }
      });
      await run('pref', 'dm', null);
      await run('pref', 'notify.new_followers', null);
      expect(tables.preferences.get('p-me')).toMatchObject({
        direct_message_policy: 'EVERYONE',
        direct_message_group_id: null,
        notifications: { new_followers: true }
      });
    });

    it("refuses a group the person can't select, and GROUP_MEMBERS without a group", async () => {
      const { run, invalid } = setup();
      expect(
        await ruleCode(
          run('pref', 'dm', {
            policy: 'GROUP_MEMBERS',
            group_id: 'hidden',
            allow_people_i_follow: true
          })
        )
      ).toBe('GROUP_NOT_SELECTABLE');
      expect(
        invalid('pref', 'dm', {
          policy: 'GROUP_MEMBERS',
          group_id: null,
          allow_people_i_follow: true
        })
      ).toThrow('needs a group_id');
      expect(invalid('pref', 'notify.everything', { on: true })).toThrow(
        'dm, level or notify'
      );
      expect(invalid('pref', 'level', { value: 'SOME' })).toThrow('A level is');
    });
  });

  describe('alias', () => {
    it('creates with a derived id, replaces members, and deletes', async () => {
      const { run, tables } = setup();
      await run('alias', 'team_a', { members: [ALICE, BOB] });
      const id = mentionAliasId('p-me', 'team_a');
      expect(tables.aliases.get(id)).toEqual({
        ownerId: 'p-me',
        alias: 'team_a',
        memberIds: ['p-alice', 'p-bob']
      });
      await run('alias', 'team_a', { members: [BOB] });
      expect(tables.aliases.get(id)?.memberIds).toEqual(['p-bob']);
      await run('alias', 'team_a', null);
      expect(tables.aliases.size).toBe(0);
      expect(mentionAliasId('p-me', 'team_a')).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      );
    });

    it('refuses a create onto a taken name, and renames keeping the id and the count', async () => {
      const { run, tables } = setup();
      await run('alias', 'team_a', { members: [ALICE] });
      expect(
        await ruleCode(run('alias', 'team_a', { members: [BOB], new: true }))
      ).toBe('ALIAS_EXISTS');
      const id = mentionAliasId('p-me', 'team_a');
      for (let i = 0; i < 19; i++) {
        tables.aliases.set(`a${i}`, {
          ownerId: 'p-me',
          alias: `other${i}`,
          memberIds: ['p-bob']
        });
      }
      // At the limit of 20, a rename (new name, then the old name's unset).
      await run('alias', 'aaa_first', { members: [BOB], from: 'team_a' });
      await run('alias', 'team_a', null);
      expect(tables.aliases.get(id)).toEqual({
        ownerId: 'p-me',
        alias: 'aaa_first',
        memberIds: ['p-bob']
      });
      expect(tables.aliases.size).toBe(20);
    });

    it('refuses a rename onto a name in use, live, and keeps both aliases', async () => {
      const { run, tables } = setup();
      await run('alias', 'teamx', { members: [ALICE] });
      await run('alias', 'crewx', { members: [BOB] });
      expect(
        await ruleCode(
          run('alias', 'crewx', { members: [ALICE], from: 'teamx' })
        )
      ).toBe('ALIAS_EXISTS');
      expect(
        tables.aliases.get(mentionAliasId('p-me', 'teamx'))?.memberIds
      ).toEqual(['p-alice']);
      expect(
        tables.aliases.get(mentionAliasId('p-me', 'crewx'))?.memberIds
      ).toEqual(['p-bob']);
    });

    it("takes a rename's record after today's request already renamed the alias", async () => {
      const { run, tables } = setup();
      await run('alias', 'teamx', { members: [ALICE] });
      const id = mentionAliasId('p-me', 'teamx');
      // Today's PUT renamed it (shadow): the record then finds the new name.
      tables.aliases.set(id, {
        ownerId: 'p-me',
        alias: 'crewx',
        memberIds: ['p-alice']
      });
      await run('alias', 'crewx', { members: [ALICE], from: 'teamx' });
      await run('alias', 'teamx', null);
      expect(Array.from(tables.aliases.entries())).toEqual([
        [id, { ownerId: 'p-me', alias: 'crewx', memberIds: ['p-alice'] }]
      ]);
    });

    it('refuses yourself, an unknown member and a 21st alias, live', async () => {
      const { run, tables } = setup();
      expect(await ruleCode(run('alias', 'team_a', { members: [ME] }))).toBe(
        'SELF'
      );
      expect(
        await ruleCode(run('alias', 'team_a', { members: [NOBODY] }))
      ).toBe('TARGET_NOT_FOUND');
      for (let i = 0; i < 20; i++) {
        tables.aliases.set(`a${i}`, {
          ownerId: 'p-me',
          alias: `other${i}`,
          memberIds: ['p-bob']
        });
      }
      expect(await ruleCode(run('alias', 'team_a', { members: [BOB] }))).toBe(
        'ALIAS_LIMIT'
      );
    });

    it('keeps the members that still resolve in a rebuild, handle or not', async () => {
      const { run, tables } = setup();
      tables.mentionable.delete('p-bob');
      await run(
        'alias',
        'team_a',
        { members: [ALICE, NOBODY, BOB] },
        'rebuild'
      );
      expect(
        tables.aliases.get(mentionAliasId('p-me', 'team_a'))?.memberIds
      ).toEqual(['p-alice', 'p-bob']);
    });

    it('checks the alias and its members', () => {
      const { invalid } = setup();
      expect(invalid('alias', 'Team', { members: [ALICE] })).toThrow(
        'An alias is'
      );
      expect(invalid('alias', 'all', { members: [ALICE] })).toThrow(
        'An alias is'
      );
      expect(invalid('alias', 'ab', { members: [ALICE] })).toThrow(
        'An alias is'
      );
      expect(invalid('alias', 'crew', { members: [] })).toThrow(
        'An alias has 1 to 25'
      );
      expect(invalid('alias', 'crew', { members: ['alice'] })).toThrow(
        'An alias has 1 to 25'
      );
    });
  });

  describe('push and eula', () => {
    const settings = {
      identity_subscribed: true,
      identity_mentioned: true,
      identity_rep: false,
      identity_nic: true,
      drop_quoted: true,
      drop_replied: true,
      drop_voted: false,
      drop_reacted: true,
      drop_boosted: true,
      wave_created: true,
      subscription_coverage: true
    };

    it('writes every push setting of a device, and the defaults', async () => {
      const { run, tables, invalid } = setup();
      await run('push', 'device-1', settings);
      expect(tables.push.get('p-me|device-1')).toEqual(settings);
      await run('push', 'device-1', null);
      expect(tables.push.size).toBe(0);
      expect(invalid('push', 'device-1', { identity_rep: false })).toThrow(
        'Push settings has the fields'
      );
    });

    it("records and withdraws EULA consent at the record's time", async () => {
      const { run, tables, invalid } = setup();
      const change = await run('eula', 'device-1', {
        version: CURRENT_EULA_VERSION,
        platform: 'ios'
      });
      expect(tables.eula.get('device-1')).toEqual({
        profileId: 'p-me',
        version: CURRENT_EULA_VERSION,
        platform: 'ios',
        at: change.order.claimedTime
      });
      await run('eula', 'device-1', null);
      expect(tables.eula.size).toBe(0);
      // Live, only the current terms, as today's route takes them.
      expect(
        await ruleCode(
          run('eula', 'device-1', { version: '2020-01-01', platform: 'ios' })
        )
      ).toBe('EULA_VERSION');
      expect(
        invalid('eula', 'device-1', { version: '', platform: 'ios' })
      ).toThrow('eula consent is');
    });
  });
});
