import { inspect } from 'node:util';
import { Wallet } from 'ethers';
import { AuthenticationContext } from '@/auth-context';
import { Logger } from '@/logging';
import {
  signingBot,
  TEST_BOT_DEVICE_KEY,
  TEST_BOT_DEVICE_SEED,
  TEST_BOT_WALLET,
  TEST_NOW,
  testBotDeviceKeyEntry
} from '@/tests/fixtures/bot-device-signing.fixture';
import { DropType } from '@/entities/IDrop';
import {
  computeAppDeviceGrantId,
  parseAppDeviceGrantMessage,
  recoversToAppGrantWallet
} from './app-device-grant';
import {
  BotDeviceKeyEntry,
  ed25519PrivateKeyFromSeed
} from './bot-device-grant';
import {
  BotDeviceKey,
  BotDeviceSigner,
  CommittedDropSignatures,
  parseBotDeviceKeys,
  signedBodyOfDropModel
} from './bot-device-signer';
import {
  computeDeviceEventId,
  DeviceEventKind,
  verifyEd25519EventSignature
} from './device-event';
import {
  toApiDeviceGrantProof,
  toApiDeviceSignedEvent
} from './device-signing.mappers';

const BOT = 'bot-profile';
const WAVE_ID = '4a1e0e2c-7a7d-4b38-9c0b-2f1d6d1c9a10';
const PARENT = 'b0c5d6e7-1111-4222-8333-944455556666';
const SEED_HEX = TEST_BOT_DEVICE_SEED.slice(2);

// Shared DN1 vectors (device-event.test.ts, the frontend and wave-events).
const DN1_BODY = {
  wave_id: WAVE_ID,
  title: null,
  parts: [{ content: 'gm é😀 "q"', media: [], quoted_drop: null }],
  referenced_nfts: [],
  mentioned_users: [],
  metadata: [],
  reply_to: { drop_id: PARENT, drop_part_id: 1 },
  signature: null,
  is_safe_signature: false,
  signer_address: '0x1111111111111111111111111111111111111111',
  drop_type: 'CHAT',
  hide_link_preview: false
};
const DN1_BODY_HASH =
  '0x21f35f2f1bfccadb13cb9ad660c3f7c38d971327557f4bf921b37511d808fcf5';
const DN1_EVENT = {
  kind: 1,
  kindVersion: 1,
  wave: WAVE_ID,
  author: '0x1111111111111111111111111111111111111111',
  keyType: 2,
  deviceKey: TEST_BOT_DEVICE_KEY,
  authRef: '0xe0b23044ded5e97599cd0d3f4ae0234df6aa13c90c633a9f12d9f597ea7f20bc',
  seq: 1760000000000,
  anchor: 0,
  claimedTime: 1760000000123,
  refs: [PARENT],
  bodyHash: DN1_BODY_HASH,
  bodySize: 418
};
const DN1_EVENT_ID =
  '0x85085439fde88ab7c9c2979f922c1eb9d3b7f528819e6e7c3befad77f935b02a';
const DN1_SIGNATURE =
  '0xf8c7552edc9013ef82b331037b34dd7ae20fa4a6aab9feea1d906c6ee1b906db03e20254917fce0832ce5768e3a676fad76cb9d47d12b5e74536aa11e9e9cf04';
// The backend's DN1 reaction body commitment (wave-events web_vectors.rs).
const DN1_REACT_BODY_HASH =
  '0xb4f2d00ed11f032283f010298cf872d11eb9d8060ce0b951a4b22fdfd8a45606';

function loggedText(spies: jest.SpyInstance[]): string {
  return spies
    .flatMap((spy) => spy.mock.calls.flat())
    .map((arg) => (typeof arg === 'string' ? arg : inspect(arg)))
    .join('\n');
}

describe('BotDeviceSigner', () => {
  let logSpies: jest.SpyInstance[];

  beforeEach(() => {
    logSpies = (['info', 'warn', 'error', 'debug'] as const).map((level) =>
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined)
    );
  });

  afterEach(() => {
    // Whatever happened, no key material reached a log line.
    const logged = loggedText(logSpies);
    expect(logged).not.toContain(SEED_HEX);
    jest.restoreAllMocks();
  });

  const write = (id = 'new-drop') => jest.fn().mockResolvedValue({ id });

  describe('the signed event', () => {
    it('signs with the shared vectors: event id, body hash and Ed25519 signature', () => {
      expect(computeDeviceEventId(DN1_EVENT)).toBe(DN1_EVENT_ID);
      const key = new BotDeviceKey(
        BOT,
        {} as never,
        ed25519PrivateKeyFromSeed(TEST_BOT_DEVICE_SEED)
      );
      expect(key.sign(DN1_EVENT_ID)).toBe(DN1_SIGNATURE);
    });

    it('passes the checks a client-signed POST passes and is stored as one', async () => {
      const { signer, store } = await signingBot({ profileId: BOT });
      const created = write();

      await expect(
        signer.createDrop(
          BOT,
          { waveId: WAVE_ID, replyToDropId: PARENT, body: DN1_BODY },
          created,
          {}
        )
      ).resolves.toEqual({ id: 'new-drop' });

      expect(created).toHaveBeenCalledTimes(1);
      const [grant] = Array.from(store.grants.values());
      expect(store.events).toHaveLength(1);
      const event = store.events[0];
      expect(event).toMatchObject({
        kind: DeviceEventKind.POST,
        wave_id: WAVE_ID,
        drop_id: 'new-drop',
        author: TEST_BOT_WALLET,
        profile_id: BOT,
        device_key: TEST_BOT_DEVICE_KEY,
        grant_id: grant.id,
        seq: TEST_NOW,
        claimed_time: TEST_NOW,
        refs: JSON.stringify([PARENT]),
        body_hash: DN1_BODY_HASH,
        body_size: 418,
        created_at: TEST_NOW
      });
      expect(event.id).toBe(
        computeDeviceEventId({
          ...DN1_EVENT,
          author: TEST_BOT_WALLET,
          authRef: grant.id,
          seq: TEST_NOW,
          claimedTime: TEST_NOW
        })
      );
      expect(
        verifyEd25519EventSignature({
          deviceKey: grant.device_key,
          eventId: event.id,
          signature: event.signature
        })
      ).toBe(true);
      expect(store.authorSignatures.get('new-drop')).toBe(event.id);
      // What the relay publisher sends: the event and the grant proof.
      expect(toApiDeviceSignedEvent(event)).toMatchObject({
        auth_ref: grant.id,
        author: TEST_BOT_WALLET
      });
      expect(toApiDeviceGrantProof(grant)).toMatchObject({
        id: grant.id,
        wallet: TEST_BOT_WALLET,
        device_key: TEST_BOT_DEVICE_KEY,
        scopes: ['post', 'react'],
        domain: '6529.io',
        chain_id: 1
      });
    });

    it('stores a grant proof that verifies as an app grant', async () => {
      const { signer, store } = await signingBot({ profileId: BOT });
      await signer.createDrop(
        BOT,
        { waveId: WAVE_ID, replyToDropId: null, body: { wave_id: WAVE_ID } },
        write(),
        {}
      );
      const [grant] = Array.from(store.grants.values());
      const parsed = parseAppDeviceGrantMessage(grant.message);
      expect(parsed).not.toBeNull();
      expect(computeAppDeviceGrantId(parsed!.message)).toBe(grant.id);
      expect(
        recoversToAppGrantWallet(parsed!.message, grant.wallet_signature)
      ).toBe(true);
      expect(grant).toMatchObject({
        wallet: TEST_BOT_WALLET,
        key_type: 'ed25519',
        device_label: '6529.io bot',
        revoked_at: null
      });
    });

    it('signs a reaction as POST /drops/{id}/reaction does', async () => {
      const { signer, store } = await signingBot({ profileId: BOT });
      const react = jest.fn().mockResolvedValue(true);

      await expect(
        signer.mutateDrop(
          BOT,
          {
            kind: DeviceEventKind.REACT,
            dropId: PARENT,
            waveId: WAVE_ID,
            body: { on: true, reaction: ':+1:' }
          },
          react,
          {}
        )
      ).resolves.toBe(true);

      expect(react).toHaveBeenCalledTimes(1);
      expect(store.events[0]).toMatchObject({
        kind: DeviceEventKind.REACT,
        drop_id: PARENT,
        refs: JSON.stringify([PARENT]),
        body: '{"on":true,"reaction":":+1:"}',
        body_hash: DN1_REACT_BODY_HASH,
        body_size: 29
      });
      // A reaction leaves the drop's author signature alone.
      expect(store.authorSignatures.size).toBe(0);
    });

    it('gives an HTTP bot an envelope the API accepts for the same body', async () => {
      const { signer, store, writes } = await signingBot({ profileId: BOT });
      const body = { wave_id: WAVE_ID, parts: [{ content: 'gm' }] };
      const envelope = await signer.envelopeFor(BOT, {
        kind: DeviceEventKind.POST,
        waveId: WAVE_ID,
        refs: [],
        body
      });
      expect(envelope).toMatchObject({
        grant_id: Array.from(store.grants.keys())[0],
        seq: TEST_NOW,
        claimed_time: TEST_NOW
      });
      // The API's own check of POST /drops, over the body as sent.
      await expect(
        writes.createDrop(
          {
            envelope: JSON.parse(JSON.stringify(envelope)),
            waveId: WAVE_ID,
            replyToDropId: null,
            body: JSON.parse(JSON.stringify(body))
          },
          write('http-drop'),
          { authenticationContext: AuthenticationContext.fromProfileId(BOT) }
        )
      ).resolves.toEqual({ id: 'http-drop' });
      expect(store.events[0].drop_id).toBe('http-drop');
    });

    it('signs again past sequence numbers another process took', async () => {
      const { signer, store } = await signingBot({ profileId: BOT });
      // Another instance of the bot wrote three times in this millisecond.
      for (let i = 0; i < 3; i++) {
        store.events.push({
          id: `0x${String(i).padStart(64, '0')}`,
          device_key: TEST_BOT_DEVICE_KEY,
          seq: TEST_NOW + i,
          drop_id: `other-${i}`
        } as never);
      }
      const created = write('mine');

      await signer.createDrop(
        BOT,
        { waveId: WAVE_ID, replyToDropId: null, body: { wave_id: WAVE_ID } },
        created,
        {}
      );

      expect(created).toHaveBeenCalledTimes(1);
      const mine = store.events.filter((event) => event.drop_id === 'mine');
      // TEST_NOW and TEST_NOW + 2 were taken; the next try jumps further.
      expect(mine.map((event) => Number(event.seq))).toEqual([TEST_NOW + 6]);
      expect(store.authorSignatures.get('mine')).toBe(mine[0].id);
    });

    it('gives each write in a process its own sequence number', async () => {
      const { signer, store } = await signingBot({ profileId: BOT });
      for (const id of ['a', 'b']) {
        await signer.createDrop(
          BOT,
          { waveId: WAVE_ID, replyToDropId: null, body: { id } },
          write(id),
          {}
        );
      }
      expect(store.events.map((event) => Number(event.seq))).toEqual([
        TEST_NOW,
        TEST_NOW + 1
      ]);
    });

    it('does not write twice when the write itself fails', async () => {
      const { signer, store } = await signingBot({ profileId: BOT });
      const failing = jest.fn().mockRejectedValue(new Error('write failed'));

      await expect(
        signer.createDrop(
          BOT,
          { waveId: WAVE_ID, replyToDropId: null, body: { wave_id: WAVE_ID } },
          failing,
          {}
        )
      ).rejects.toThrow('write failed');

      expect(failing).toHaveBeenCalledTimes(1);
      expect(store.events).toHaveLength(0);
      expect(store.released).toHaveLength(1);
    });
  });

  describe('without a usable key the bot writes unsigned, as before', () => {
    it('warns once when no bot has a key', async () => {
      const signer = new BotDeviceSigner(
        () => Promise.reject(new Error('not loaded')),
        () => undefined,
        () => TEST_NOW
      );
      const created = write();
      for (let i = 0; i < 2; i++) {
        await signer.createDrop(
          BOT,
          { waveId: WAVE_ID, replyToDropId: null, body: {} },
          created,
          {}
        );
      }
      expect(created).toHaveBeenCalledTimes(2);
      await expect(signer.profileIdOfWallet(TEST_BOT_WALLET)).resolves.toBe(
        null
      );
      const warnings = logSpies[1].mock.calls.flat().join('\n');
      expect(warnings.match(/BOT DROPS UNSIGNED/g)).toHaveLength(1);
    });

    it('warns once for a bot left out of the keys', async () => {
      const { signer, store } = await signingBot({ profileId: 'other-bot' });
      const created = write();
      await signer.createDrop(
        BOT,
        { waveId: WAVE_ID, replyToDropId: null, body: {} },
        created,
        {}
      );
      await signer.createDrop(
        BOT,
        { waveId: WAVE_ID, replyToDropId: null, body: {} },
        created,
        {}
      );
      expect(created).toHaveBeenCalledTimes(2);
      expect(store.events).toHaveLength(0);
      expect(
        logSpies[1].mock.calls
          .flat()
          .filter((line: string) => line.includes(`[PROFILE ${BOT}]`))
      ).toHaveLength(1);
    });

    it('writes unsigned after the grant expired, and warns ahead of expiry', async () => {
      let now = TEST_NOW;
      const { signer, store } = await signingBot({
        profileId: BOT,
        now: () => now
      });
      const [grantExpiresAt] = await (async () => {
        const entry = await testBotDeviceKeyEntry();
        return [JSON.parse(entry.grant_message).expiresAt * 1000];
      })();
      now = grantExpiresAt - 24 * 60 * 60 * 1000;
      await signer.createDrop(
        BOT,
        { waveId: WAVE_ID, replyToDropId: null, body: {} },
        write('soon'),
        {}
      );
      expect(store.events).toHaveLength(1);
      expect(logSpies[1].mock.calls.flat().join('\n')).toContain(
        'BOT DEVICE GRANT EXPIRING'
      );
      now = grantExpiresAt;
      const late = write('late');
      await signer.createDrop(
        BOT,
        { waveId: WAVE_ID, replyToDropId: null, body: {} },
        late,
        {}
      );
      expect(late).toHaveBeenCalledTimes(1);
      expect(store.events).toHaveLength(1);
      expect(logSpies[1].mock.calls.flat().join('\n')).toContain(
        'the device grant expired'
      );
    });

    it('writes unsigned, logged, when the grant wallet is not the bot profile', async () => {
      const { signer, store } = await signingBot({
        profileId: BOT,
        walletProfileId: 'someone-else'
      });
      const created = write();

      await expect(
        signer.createDrop(
          BOT,
          { waveId: WAVE_ID, replyToDropId: null, body: {} },
          created,
          {}
        )
      ).resolves.toEqual({ id: 'new-drop' });

      expect(created).toHaveBeenCalledTimes(1);
      expect(store.events).toHaveLength(0);
      expect(logSpies[1].mock.calls.flat().join('\n')).toContain(
        'grant wallet does not belong to the acting profile'
      );
    });

    it.each([
      'insertGrant',
      'findGrantById',
      'getProfileIdByWallet',
      'reserveEvent'
    ])(
      'writes unsigned, with a warning, when %s fails before the write',
      async (call) => {
        const { signer, store } = await signingBot({ profileId: BOT });
        store.failing.add(call);
        const created = write();

        await expect(
          signer.createDrop(
            BOT,
            { waveId: WAVE_ID, replyToDropId: null, body: {} },
            created,
            {}
          )
        ).resolves.toEqual({ id: 'new-drop' });

        expect(created).toHaveBeenCalledTimes(1);
        expect(store.events).toHaveLength(0);
        expect(logSpies[1].mock.calls.flat().join('\n')).toContain(
          'database unavailable'
        );
      }
    );

    it('writes unsigned a body relays would refuse: a cut emoji', async () => {
      const { signer, store } = await signingBot({ profileId: BOT });
      const cut = 'release notes 😀'.slice(0, 15);
      const created = write();

      await signer.createDrop(
        BOT,
        {
          waveId: WAVE_ID,
          replyToDropId: null,
          body: { parts: [{ content: cut }] }
        },
        created,
        {}
      );

      expect(created).toHaveBeenCalledTimes(1);
      expect(store.events).toHaveLength(0);
      expect(logSpies[1].mock.calls.flat().join('\n')).toContain(
        'half an emoji'
      );
      await expect(
        signer.envelopeFor(BOT, {
          kind: DeviceEventKind.POST,
          waveId: WAVE_ID,
          refs: [],
          body: { content: cut }
        })
      ).resolves.toBeUndefined();
    });

    it('writes a body that is not plain JSON unsigned, with or without a key', async () => {
      const body = { n: BigInt(1) };
      const unconfigured = new BotDeviceSigner(
        () => Promise.reject(new Error('not loaded')),
        () => undefined,
        () => TEST_NOW
      );
      const created = write();
      await unconfigured.mutateDrop(
        null,
        { kind: DeviceEventKind.REACT, dropId: PARENT, waveId: WAVE_ID, body },
        created,
        {}
      );
      const { signer, store } = await signingBot({ profileId: BOT });
      await signer.mutateDrop(
        BOT,
        { kind: DeviceEventKind.REACT, dropId: PARENT, waveId: WAVE_ID, body },
        created,
        {}
      );
      expect(created).toHaveBeenCalledTimes(2);
      expect(store.events).toHaveLength(0);
    });

    it('never signs inside a caller transaction', async () => {
      const { signer, store } = await signingBot({ profileId: BOT });
      const created = write();
      for (let i = 0; i < 2; i++) {
        await signer.createDrop(
          BOT,
          { waveId: WAVE_ID, replyToDropId: null, body: {} },
          created,
          { connection: {} as never }
        );
      }
      expect(created).toHaveBeenCalledTimes(2);
      expect(store.events).toHaveLength(0);
      expect(
        logSpies[1].mock.calls
          .flat()
          .filter((line: string) => line.includes("caller's transaction"))
      ).toHaveLength(1);
    });
  });

  describe('posts written inside a transaction', () => {
    it('are signed only after the commit, with the committed drop id', async () => {
      const { signer, store } = await signingBot({ profileId: BOT });
      const signatures = new CommittedDropSignatures(signer);
      // Inside the transaction: the post is written, nothing is stored yet.
      signatures.add({
        botProfileId: BOT,
        dropId: 'committed-drop',
        waveId: WAVE_ID,
        replyToDropId: null,
        body: { wave_id: WAVE_ID, parts: [{ content: 'Mint is live' }] }
      });
      expect(store.events).toHaveLength(0);

      await signatures.signCommitted({});

      expect(store.events).toHaveLength(1);
      expect(store.events[0]).toMatchObject({
        kind: DeviceEventKind.POST,
        drop_id: 'committed-drop',
        wave_id: WAVE_ID,
        refs: '[]'
      });
      expect(store.authorSignatures.get('committed-drop')).toBe(
        store.events[0].id
      );
      // Signed once only.
      await signatures.signCommitted({});
      expect(store.events).toHaveLength(1);
    });

    it('leave nothing behind when the transaction rolls back', async () => {
      const { signer, store } = await signingBot({ profileId: BOT });
      const signatures = new CommittedDropSignatures(signer);
      const transaction = async () => {
        signatures.add({
          botProfileId: BOT,
          dropId: 'rolled-back-drop',
          waveId: WAVE_ID,
          replyToDropId: null,
          body: {}
        });
        throw new Error('rolled back');
      };
      await expect(
        transaction().then(() => signatures.signCommitted({}))
      ).rejects.toThrow('rolled back');
      expect(store.events).toHaveLength(0);
      expect(store.authorSignatures.size).toBe(0);
      expect(store.released).toHaveLength(0);
    });

    it('stay unsigned when signCommitted runs inside an outer transaction', async () => {
      const { signer, store } = await signingBot({ profileId: BOT });
      const signatures = new CommittedDropSignatures(signer);
      signatures.add({
        botProfileId: BOT,
        dropId: 'drop',
        waveId: WAVE_ID,
        replyToDropId: null,
        body: {}
      });
      await signatures.signCommitted({ connection: {} as never });
      expect(store.events).toHaveLength(0);
      expect(logSpies[1].mock.calls.flat().join('\n')).toContain(
        'outer transaction'
      );
    });

    it('never throw: a failed signature is logged', async () => {
      const { signer, store } = await signingBot({ profileId: BOT });
      store.failing.add('reserveEvent');
      await expect(
        signer.signCommittedDrop(BOT, {
          dropId: 'drop',
          waveId: WAVE_ID,
          replyToDropId: null,
          body: {}
        })
      ).resolves.toBeUndefined();
      expect(store.events).toHaveLength(0);
    });
  });

  describe('the signer object', () => {
    it('never shows the seeds, alone or inside a service', async () => {
      const { signer } = await signingBot({ profileId: BOT });
      await signer.createDrop(
        BOT,
        { waveId: WAVE_ID, replyToDropId: null, body: { a: 1 } },
        write(),
        {}
      );
      const holder = { botSigner: signer, nested: { signer } };
      for (const shown of [
        inspect(signer, { depth: 10, showHidden: true }),
        inspect(holder, { depth: 10 }),
        JSON.stringify(signer),
        JSON.stringify(holder),
        String(signer)
      ]) {
        expect(shown).not.toContain(SEED_HEX);
      }
    });
  });

  describe('parseBotDeviceKeys', () => {
    let TEST_ENTRY: BotDeviceKeyEntry;
    beforeAll(async () => {
      TEST_ENTRY = await testBotDeviceKeyEntry();
    });

    it('reads the CLI entry', () => {
      const { keys, problems } = parseBotDeviceKeys(
        JSON.stringify({ [BOT]: TEST_ENTRY }),
        TEST_NOW
      );
      expect(problems).toEqual([]);
      const key = keys.get(BOT)!;
      expect(key.profileId).toBe(BOT);
      expect(key.grant.device_key).toBe(TEST_BOT_DEVICE_KEY);
      // The private key is no field: logs and JSON never carry it.
      expect(JSON.stringify(key)).not.toContain(SEED_HEX);
      expect(inspect(key, { depth: 5 })).not.toContain(SEED_HEX);
    });

    it('reads the setting as JSON text, as JSON text inside a string, or as an object', () => {
      const object = { [BOT]: TEST_ENTRY };
      for (const raw of [
        JSON.stringify(object),
        JSON.stringify(JSON.stringify(object)),
        object
      ]) {
        const { keys, problems } = parseBotDeviceKeys(raw, TEST_NOW);
        expect(problems).toEqual([]);
        expect(keys.get(BOT)?.grant.device_key).toBe(TEST_BOT_DEVICE_KEY);
      }
    });

    it.each([
      ['not JSON', '{', /is not JSON/],
      ['not an object', '[]', /not an object/],
      [
        'an object the secret turned into text',
        '[object Object]',
        /"\[object Object\]": store it in the secret as one JSON string/
      ],
      ['an entry without fields', JSON.stringify({ [BOT]: {} }), /needs/]
    ])('reports %s', (_name, raw, problem) => {
      const { keys, problems } = parseBotDeviceKeys(raw, TEST_NOW);
      expect(keys.size).toBe(0);
      expect(problems.join('\n')).toMatch(problem);
    });

    it('leaves out entries that do not hold together', async () => {
      const otherSeed = `0x${'11'.repeat(32)}`;
      const otherWallet = await testBotDeviceKeyEntry({
        walletKey: Wallet.createRandom().privateKey
      });
      const tampered = JSON.parse(TEST_ENTRY.grant_message);
      tampered.scopes = 'post,edit,delete,react,vote';
      const { keys, problems } = parseBotDeviceKeys(
        JSON.stringify({
          seed: { ...TEST_ENTRY, device_seed: 'not hex' },
          other_key: { ...TEST_ENTRY, device_seed: otherSeed },
          other_wallet: {
            ...TEST_ENTRY,
            grant_signature: otherWallet.grant_signature
          },
          terms: { ...TEST_ENTRY, grant_message: JSON.stringify(tampered) }
        }),
        TEST_NOW
      );
      expect(keys.size).toBe(0);
      expect(problems).toEqual([
        '[PROFILE seed] device_seed is not 0x and 64 lowercase hex digits',
        "[PROFILE other_key] device_seed is not the grant's device key",
        "[PROFILE other_wallet] grant_signature is not the grant wallet's own signature",
        '[PROFILE terms] grant_message is not an app device grant'
      ]);
      expect(problems.join('\n')).not.toContain(otherSeed.slice(2));
    });

    it('logs a refused entry once per setting', async () => {
      const raw = JSON.stringify({ [BOT]: { ...TEST_ENTRY, device_seed: '' } });
      const signer = new BotDeviceSigner(
        () => Promise.reject(new Error('not loaded')),
        () => raw,
        () => TEST_NOW
      );
      for (let i = 0; i < 2; i++) {
        await signer.createDrop(
          BOT,
          { waveId: WAVE_ID, replyToDropId: null, body: {} },
          write(),
          {}
        );
      }
      expect(
        logSpies[2].mock.calls
          .flat()
          .filter((line: string) => line.includes('BOT DEVICE KEY LEFT OUT'))
      ).toHaveLength(1);
    });
  });

  it('finds a bot profile by wallet only when some bot has a key', async () => {
    const { signer } = await signingBot({ profileId: BOT });
    await expect(
      signer.profileIdOfWallet(
        TEST_BOT_WALLET.toUpperCase().replace('0X', '0x')
      )
    ).resolves.toBe(BOT);
  });

  it('describes a model-written drop as its POST /drops body', () => {
    expect(
      signedBodyOfDropModel({
        drop_id: null,
        wave_id: WAVE_ID,
        reply_to: { drop_id: PARENT, drop_part_id: 1 },
        title: null,
        parts: [
          {
            content: 'gm',
            quoted_drop: null,
            media: [
              { url: 'https://example.com/a.png', mime_type: 'image/png' }
            ],
            attachments: []
          }
        ],
        referenced_nfts: [],
        mentioned_users: [{ handle: 'someone' }],
        mentioned_waves: [],
        metadata: [{ data_key: 'k', data_value: 'v' }],
        author_identity: 'bot',
        author_id: BOT,
        drop_type: DropType.CHAT,
        mentioned_groups: [],
        signature: null,
        is_additional_action_promised: null
      })
    ).toEqual({
      wave_id: WAVE_ID,
      title: null,
      drop_type: 'CHAT',
      reply_to: { drop_id: PARENT, drop_part_id: 1 },
      parts: [
        {
          content: 'gm',
          quoted_drop: null,
          media: [{ url: 'https://example.com/a.png', mime_type: 'image/png' }]
        }
      ],
      referenced_nfts: [],
      mentioned_users: [{ handle_in_content: 'someone' }],
      mentioned_waves: [],
      mentioned_groups: [],
      metadata: [{ data_key: 'k', data_value: 'v' }],
      signature: null
    });
  });
});
