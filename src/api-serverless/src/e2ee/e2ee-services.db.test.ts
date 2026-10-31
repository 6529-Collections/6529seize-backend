import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { HDNodeWallet, keccak256, Wallet } from 'ethers';
import { E2eeServiceDeps, pruneE2eeBlobs } from '@/api/e2ee/e2ee-context';
import { E2eeEventPublisher } from '@/api/e2ee/e2ee-events';
import { createE2eeServices } from '@/api/e2ee/e2ee.handlers';
import { ApiE2eeReportCategory } from '@/api/generated/models/ApiE2eeReportCategory';
import { E2eeTrustAndSafetyService } from '@/api/e2ee/e2ee-trust-and-safety.service';
import {
  CONTENT_MODERATION_PROFILE_BLOCKS_TABLE,
  E2EE_LOG_TABLE,
  IDENTITY_SUBSCRIPTIONS_TABLE,
  PROFILE_PREFERENCES_TABLE
} from '@/constants/db-tables';
import {
  E2EE_CIPHERSUITE,
  E2EE_ENTRY_BUCKETS,
  E2EE_MAX_ENTRY_AND_WELCOME_BYTES
} from '@/e2ee/e2ee.constants';
import { E2eeDb } from '@/e2ee/e2ee.db';
import { migrateE2eeBlobsToS3 } from '@/e2ee/e2ee-blob-migration';
import { S3E2eeBlobStore } from '@/e2ee/e2ee-blob-store.s3';
import { createE2eeBlobStores } from '@/e2ee/e2ee-blob-stores';
import {
  E2EE_ZERO_32,
  E2eeEntryKind,
  e2eeEntryDigest,
  e2eeMessageDigest,
  e2eeRevokeDigest,
  e2eeRosterDigest
} from '@/e2ee/e2ee-digests';
import { E2eeApiException } from '@/e2ee/e2ee-errors';
import { buildE2eeGrantTypedData, E2eeDeviceGrant } from '@/e2ee/e2ee-grant';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import {
  E2eeTestKey,
  randomE2eeGroupHandle,
  randomE2eeKey
} from '@/tests/fixtures/e2ee.fixture';
import { InMemoryE2eeBlobS3 } from '@/tests/fixtures/e2ee-blob-s3.fixture';

const START = Date.UTC(2026, 9, 12, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
const BLOB_BUCKET = 'private-e2ee-test-bucket';
const BLOB_PREFIX = 'test/e2ee-blobs';
const S3_BLOB_ENV = {
  E2EE_BLOB_STORE: 's3',
  E2EE_BLOB_S3_BUCKET: BLOB_BUCKET,
  E2EE_BLOB_S3_PREFIX: BLOB_PREFIX,
  E2EE_BLOB_S3_REGION: 'eu-west-1'
};

interface Profile {
  readonly id: string;
  readonly wallet: HDNodeWallet;
}

interface RecordedEvent {
  readonly method: keyof E2eeEventPublisher;
  readonly args: unknown[];
}

function aProfile(): Profile {
  return {
    id: `profile-${randomBytes(6).toString('hex')}`,
    wallet: Wallet.createRandom()
  };
}

async function expectE2eeError(
  promise: Promise<unknown>,
  code: string,
  details?: Record<string, unknown>
): Promise<E2eeApiException> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(E2eeApiException);
  const error = caught as E2eeApiException;
  expect(error.code).toBe(code);
  if (details) expect(error.details).toEqual(details);
  return error;
}

async function insertRow(table: string, row: Record<string, unknown>) {
  const columns = Object.keys(row);
  await sqlExecutor.execute(
    `insert into ${table} (${columns.join(', ')}) values (${columns
      .map((column) => `:${column}`)
      .join(', ')})`,
    row
  );
}

async function setDmPolicy(profileId: string, policy: string) {
  await insertRow(PROFILE_PREFERENCES_TABLE, {
    profile_id: profileId,
    direct_message_policy: policy,
    notification_level: 'ALL',
    notify_direct_messages: true,
    notify_mentions_replies_quotes: true,
    notify_reactions_votes_boosts: true,
    notify_new_followers: true,
    notify_rep_and_nic: true,
    notify_subscription_coverage: true
  });
}

async function follow(subscriberId: string, targetId: string) {
  await insertRow(IDENTITY_SUBSCRIPTIONS_TABLE, {
    subscriber_id: subscriberId,
    target_id: targetId,
    target_type: 'IDENTITY',
    target_action: 'DROP_CREATED'
  });
}

async function block(blockerId: string, blockedId: string) {
  await insertRow(CONTENT_MODERATION_PROFILE_BLOCKS_TABLE, {
    blocker_profile_id: blockerId,
    blocked_profile_id: blockedId,
    created_at: START
  });
}

describeWithSeed('E2EE delivery service', [], () => {
  let now: number;
  let events: RecordedEvent[];
  let walletProfiles: Map<string, string>;
  let db: E2eeDb;
  let services: ReturnType<typeof createE2eeServices>;
  let randomValue: number;
  let attachmentsEnabled: boolean;
  let blobEnv: Record<string, string | undefined>;
  let s3: InMemoryE2eeBlobS3;
  let deps: E2eeServiceDeps;

  beforeEach(() => {
    now = START;
    events = [];
    walletProfiles = new Map();
    randomValue = 1;
    attachmentsEnabled = true;
    blobEnv = {};
    s3 = new InMemoryE2eeBlobS3(BLOB_BUCKET);
    db = new E2eeDb(() => sqlExecutor);
    const record =
      (method: keyof E2eeEventPublisher) =>
      async (...args: unknown[]) => {
        events.push({ method, args });
      };
    deps = {
      db,
      events: {
        groupEvent: record('groupEvent'),
        welcomes: record('welcomes'),
        deviceAdded: record('deviceAdded'),
        deviceRevoked: record('deviceRevoked'),
        rosterChanged: record('rosterChanged'),
        wake: record('wake')
      },
      contractWalletVerifier: {
        hasCode: async () => false,
        isValidSignature: async () => false
      },
      resolveWalletProfileId: async (wallet) =>
        walletProfiles.get(wallet) ?? null,
      now: () => now,
      random: () => randomValue,
      randomHex: (bytes) => `0x${randomBytes(bytes).toString('hex')}`,
      attachmentsEnabled: () => attachmentsEnabled,
      blobStores: createE2eeBlobStores({
        rows: db,
        env: () => blobEnv,
        s3Client: () => s3
      })
    };
    services = createE2eeServices(deps);
  });

  const nowSeconds = () => Math.floor(now / 1000);

  function grantFor(profile: Profile, key: E2eeTestKey): E2eeDeviceGrant {
    const issuedAt = nowSeconds();
    return {
      wallet: profile.wallet.address.toLowerCase(),
      device_key: key.publicKey,
      ciphersuite: E2EE_CIPHERSUITE,
      issued_at: issuedAt,
      expires_at: Math.floor(issuedAt / 60) * 60 + 180 * 86400,
      origin: 'staging.6529.io'
    };
  }

  async function signGrant(profile: Profile, grant: E2eeDeviceGrant) {
    const typedData = buildE2eeGrantTypedData(grant);
    return profile.wallet.signTypedData(
      typedData.domain,
      typedData.types,
      typedData.message
    );
  }

  async function registerDevice(
    profile: Profile,
    key: E2eeTestKey = randomE2eeKey()
  ): Promise<E2eeTestKey> {
    walletProfiles.set(profile.wallet.address.toLowerCase(), profile.id);
    const grant = grantFor(profile, key);
    await services.devices.registerDevice(profile.id, {
      grant,
      wallet_signature: await signGrant(profile, grant),
      platform: 'web' as never
    });
    return key;
  }

  interface TestGroup {
    readonly g: string;
    keys: E2eeTestKey[];
  }

  async function createGroup(
    profile: Profile,
    device: E2eeTestKey
  ): Promise<TestGroup> {
    const g = randomE2eeGroupHandle();
    const k0 = randomE2eeKey();
    await services.groups.createGroup(profile.id, {
      group: g,
      commit_key: k0.publicKey,
      creator_device_key: device.publicKey
    });
    return { g, keys: [k0] };
  }

  function entryRequest(input: {
    group: TestGroup;
    epoch: number;
    sender: E2eeTestKey;
    kind?: E2eeEntryKind;
    signer?: E2eeTestKey;
    next?: E2eeTestKey;
    rosterAdd?: string[];
    rosterRemove?: string[];
    welcomeTargets?: string[];
    entryBytes?: number;
    welcomeBytes?: number;
  }) {
    const kind = input.kind ?? E2eeEntryKind.COMMIT;
    const data = randomBytes(input.entryBytes ?? 2048);
    const entryHash = keccak256(data);
    const isCommit = kind === E2eeEntryKind.COMMIT;
    const epochCommitment = isCommit
      ? keccak256(randomBytes(32))
      : E2EE_ZERO_32;
    const nextCommitKey = isCommit
      ? (input.next ?? randomE2eeKey()).publicKey
      : E2EE_ZERO_32;
    const signer = input.signer ?? input.group.keys[input.epoch];
    const signature = signer.sign(
      e2eeEntryDigest({
        group: input.group.g,
        epoch: input.epoch,
        kind,
        entryHash,
        epochCommitment,
        nextCommitKey,
        paddedLen: data.length
      })
    );
    return {
      kind: (isCommit ? 'commit' : 'proposal') as never,
      epoch: input.epoch,
      data: data.toString('base64'),
      entry_hash: entryHash,
      epoch_commitment: epochCommitment,
      next_commit_key: nextCommitKey,
      signature,
      sender_device_key: input.sender.publicKey,
      roster_add: input.rosterAdd,
      roster_remove: input.rosterRemove,
      welcome: input.welcomeTargets
        ? {
            data: randomBytes(input.welcomeBytes ?? 300).toString('base64'),
            targets: input.welcomeTargets
          }
        : undefined
    };
  }

  /** Commits the next epoch and records its commit key. */
  async function commit(
    profile: Profile,
    group: TestGroup,
    sender: E2eeTestKey,
    extra: {
      rosterAdd?: string[];
      rosterRemove?: string[];
      welcomeTargets?: string[];
      entryBytes?: number;
      welcomeBytes?: number;
    } = {}
  ) {
    const epoch = group.keys.length - 1;
    const next = randomE2eeKey();
    const item = await services.groups.submitEntry(
      profile.id,
      group.g,
      entryRequest({ group, epoch, sender, next, ...extra })
    );
    group.keys.push(next);
    return item;
  }

  async function sendMessage(
    profile: Profile,
    group: TestGroup,
    sender: E2eeTestKey,
    notify: string[] = []
  ) {
    return services.groups.sendMessage(profile.id, group.g, {
      epoch: group.keys.length - 1,
      data: randomBytes(512).toString('base64'),
      epoch_fp: '0123456789abcdef',
      sender_device_key: sender.publicKey,
      notify: notify.map((profileId) => ({
        profile_id: profileId,
        kind: 'mention' as never
      }))
    });
  }

  async function uploadKeyPackages(
    profile: Profile,
    device: E2eeTestKey,
    oneTime: number,
    lastResort = false
  ) {
    const keyPackages = Array.from({ length: oneTime }, (_, index) => ({
      data: Buffer.from(`kp-${device.publicKey}-${index}`).toString('base64'),
      last_resort: false,
      expires_at: nowSeconds() + 30 * 86400
    }));
    if (lastResort) {
      keyPackages.push({
        data: Buffer.from(`last-resort-${device.publicKey}`).toString('base64'),
        last_resort: true,
        expires_at: nowSeconds() + 90 * 86400
      });
    }
    return services.devices.uploadKeyPackages(profile.id, device.publicKey, {
      key_packages: keyPackages
    });
  }

  describe('devices', () => {
    it('registers, lists and renews a device', async () => {
      const alice = aProfile();
      const key = await registerDevice(alice);
      const me = await services.devices.getMe(alice.id);
      expect(me.devices).toHaveLength(1);
      expect(me.devices[0]).toMatchObject({
        device_key: key.publicKey,
        profile_id: alice.id,
        verified_via: 'eoa',
        label: 'Device',
        revoked_at: null,
        revocation: null
      });
      expect(me.key_packages).toEqual([
        {
          device_key: key.publicKey,
          one_time_available: 0,
          last_resort_expires_at: null
        }
      ]);
      expect(events.map((event) => event.method)).toEqual(['deviceAdded']);
      now += DAY;
      await registerDevice(alice, key);
      const renewed = await services.devices.getDevice(key.publicKey);
      expect(renewed.grant.issued_at).toBe(nowSeconds());
      expect(await services.devices.getProfileDevices(alice.id)).toHaveLength(
        1
      );
    });

    it('looks up devices of profiles and by key in one request', async () => {
      const alice = aProfile();
      const bob = aProfile();
      const aliceKey = await registerDevice(alice);
      const bobKey = await registerDevice(bob);
      const bobOld = await registerDevice(bob);
      const revokedAt = nowSeconds();
      await services.devices.revokeDevice(bob.id, bobOld.publicKey, {
        revoker_device_key: bobOld.publicKey,
        revoked_at: revokedAt,
        signature: bobOld.sign(
          e2eeRevokeDigest({
            targetDeviceKey: bobOld.publicKey,
            revokerDeviceKey: bobOld.publicKey,
            revokedAtSeconds: revokedAt
          })
        )
      });
      const lookup = await services.devices.lookupDevices({
        profile_ids: [bob.id, 'unknown-profile'],
        device_keys: [
          aliceKey.publicKey,
          bobKey.publicKey,
          randomE2eeKey().publicKey
        ]
      });
      expect(lookup.devices.map((device) => device.device_key).sort()).toEqual(
        [aliceKey.publicKey, bobKey.publicKey, bobOld.publicKey].sort()
      );
      expect(
        lookup.devices.find((device) => device.device_key === bobOld.publicKey)
          ?.revoked_at
      ).toBe(now);
      now += 91 * DAY;
      const later = await services.devices.lookupDevices({
        profile_ids: [bob.id]
      });
      expect(later.devices.map((device) => device.device_key)).toEqual([
        bobKey.publicKey
      ]);
    });

    it('rejects a grant whose wallet is not in the caller profile', async () => {
      const alice = aProfile();
      const mallory = aProfile();
      walletProfiles.set(alice.wallet.address.toLowerCase(), alice.id);
      const grant = grantFor(alice, randomE2eeKey());
      await expectE2eeError(
        services.devices.registerDevice(mallory.id, {
          grant,
          wallet_signature: await signGrant(alice, grant),
          platform: 'web' as never
        }),
        'E2EE_BAD_GRANT'
      );
    });

    it('rejects an expired grant', async () => {
      const alice = aProfile();
      walletProfiles.set(alice.wallet.address.toLowerCase(), alice.id);
      const grant = grantFor(alice, randomE2eeKey());
      const signature = await signGrant(alice, grant);
      now += 182 * DAY;
      await expectE2eeError(
        services.devices.registerDevice(alice.id, {
          grant,
          wallet_signature: signature,
          platform: 'web' as never
        }),
        'E2EE_BAD_GRANT'
      );
    });

    it('limits a profile to 10 active devices and protects keys of other profiles', async () => {
      const alice = aProfile();
      const keys: E2eeTestKey[] = [];
      for (let i = 0; i < 10; i++) keys.push(await registerDevice(alice));
      await expectE2eeError(registerDevice(alice), 'E2EE_DEVICE_LIMIT');
      const bob = aProfile();
      await expectE2eeError(registerDevice(bob, keys[0]), 'E2EE_DEVICE_EXISTS');
    });
  });

  describe('group ordering', () => {
    it('sequences commits per epoch and rejects stale or forged ones', async () => {
      const alice = aProfile();
      const device = await registerDevice(alice);
      const group = await createGroup(alice, device);
      const first = await commit(alice, group, device);
      expect(first).toMatchObject({
        seq: 1,
        epoch: 0,
        kind: 'commit',
        type: 'entry'
      });
      await expectE2eeError(
        services.groups.submitEntry(
          alice.id,
          group.g,
          entryRequest({ group, epoch: 0, sender: device })
        ),
        'E2EE_EPOCH_CONFLICT',
        { current_epoch: 1 }
      );
      await expectE2eeError(
        services.groups.submitEntry(
          alice.id,
          group.g,
          entryRequest({
            group,
            epoch: 1,
            sender: device,
            signer: group.keys[0]
          })
        ),
        'E2EE_BAD_SIGNATURE'
      );
      const second = await commit(alice, group, device);
      expect(second).toMatchObject({ seq: 2, epoch: 1 });
      const fetched = await services.groups.getGroup(
        alice.id,
        group.g,
        device.publicKey
      );
      expect(fetched).toMatchObject({
        epoch: 2,
        commit_key: group.keys[2].publicKey,
        last_seq: 2
      });
    });

    it('lets exactly one of two concurrent commits for an epoch win', async () => {
      const alice = aProfile();
      const device = await registerDevice(alice);
      const group = await createGroup(alice, device);
      const results = await Promise.allSettled([
        services.groups.submitEntry(
          alice.id,
          group.g,
          entryRequest({ group, epoch: 0, sender: device })
        ),
        services.groups.submitEntry(
          alice.id,
          group.g,
          entryRequest({ group, epoch: 0, sender: device })
        )
      ]);
      const fulfilled = results.filter(
        (result) => result.status === 'fulfilled'
      );
      const rejected = results.filter(
        (result): result is PromiseRejectedResult =>
          result.status === 'rejected'
      );
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toBeInstanceOf(E2eeApiException);
      expect(rejected[0].reason.code).toBe('E2EE_EPOCH_CONFLICT');
      expect(rejected[0].reason.details).toEqual({ current_epoch: 1 });
      const rows = await sqlExecutor.execute(
        `select seq from ${E2EE_LOG_TABLE} where group_handle = :g`,
        { g: group.g }
      );
      expect(rows).toHaveLength(1);
    });

    it('accepts messages only for the current epoch', async () => {
      const alice = aProfile();
      const device = await registerDevice(alice);
      const group = await createGroup(alice, device);
      const message = await sendMessage(alice, group, device);
      expect(message.seq).toBe(1);
      await commit(alice, group, device);
      await expectE2eeError(
        services.groups.sendMessage(alice.id, group.g, {
          epoch: 0,
          data: randomBytes(512).toString('base64'),
          epoch_fp: '0123456789abcdef',
          sender_device_key: device.publicKey
        }),
        'E2EE_EPOCH_STALE',
        { current_epoch: 1 }
      );
      await expectE2eeError(
        services.groups.sendMessage(alice.id, group.g, {
          epoch: 1,
          data: randomBytes(500).toString('base64'),
          epoch_fp: '0123456789abcdef',
          sender_device_key: device.publicKey
        }),
        'E2EE_BAD_REQUEST'
      );
    });

    it('caps proposals to leaves of the proposer and stops their delivery at once', async () => {
      const alice = aProfile();
      const bob = aProfile();
      const aliceDevice = await registerDevice(alice);
      const bobDevice = await registerDevice(bob);
      const group = await createGroup(alice, aliceDevice);
      await commit(alice, group, aliceDevice, {
        rosterAdd: [bobDevice.publicKey]
      });
      await expectE2eeError(
        services.groups.submitEntry(
          bob.id,
          group.g,
          entryRequest({
            group,
            epoch: 1,
            sender: bobDevice,
            kind: E2eeEntryKind.PROPOSAL,
            rosterRemove: [aliceDevice.publicKey]
          })
        ),
        'E2EE_FORBIDDEN'
      );
      const leave = await services.groups.submitEntry(
        bob.id,
        group.g,
        entryRequest({
          group,
          epoch: 1,
          sender: bobDevice,
          kind: E2eeEntryKind.PROPOSAL,
          rosterRemove: [bobDevice.publicKey]
        })
      );
      expect(leave).toMatchObject({ kind: 'proposal', epoch: 1 });
      const afterLeave = await services.groups.getGroup(
        bob.id,
        group.g,
        bobDevice.publicKey
      );
      expect(afterLeave.roster).toEqual([]);
      expect(afterLeave.epoch).toBe(1);
      // The leaver keeps reading epoch 1, including the commit removing it.
      await commit(alice, group, aliceDevice, {
        rosterRemove: [bobDevice.publicKey]
      });
      const bobLog = await services.groups.getLog(bob.id, group.g, {
        device_key: bobDevice.publicKey
      });
      expect(bobLog.items.map((item) => [item.seq, item.kind])).toEqual([
        [2, 'proposal'],
        [3, 'commit']
      ]);
      // A member's repair cannot undo the leave at the delivery level.
      const deviceKeys = [aliceDevice.publicKey, bobDevice.publicKey];
      await expectE2eeError(
        services.groups.repairRoster(alice.id, group.g, {
          epoch: 2,
          device_keys: deviceKeys,
          requester_device_key: aliceDevice.publicKey,
          signature: group.keys[2].sign(
            e2eeRosterDigest({ group: group.g, epoch: 2, deviceKeys })
          )
        }),
        'E2EE_FORBIDDEN'
      );
    });
  });

  describe('roster windows', () => {
    it('hides later items from removed devices and earlier items from new ones', async () => {
      const alice = aProfile();
      const bob = aProfile();
      const carol = aProfile();
      const aliceDevice = await registerDevice(alice);
      const bobDevice = await registerDevice(bob);
      const carolDevice = await registerDevice(carol);
      const group = await createGroup(alice, aliceDevice);
      await commit(alice, group, aliceDevice, {
        rosterAdd: [bobDevice.publicKey]
      }); // seq 1
      await sendMessage(alice, group, aliceDevice); // seq 2, epoch 1
      await commit(alice, group, aliceDevice, {
        rosterRemove: [bobDevice.publicKey]
      }); // seq 3, epoch 1
      await sendMessage(alice, group, aliceDevice); // seq 4, epoch 2
      await commit(alice, group, aliceDevice, {
        rosterAdd: [carolDevice.publicKey]
      }); // seq 5, epoch 2
      await sendMessage(alice, group, aliceDevice); // seq 6, epoch 3

      const bobLog = await services.groups.getLog(bob.id, group.g, {
        device_key: bobDevice.publicKey
      });
      expect(bobLog.items.map((item) => item.seq)).toEqual([2, 3]);
      expect(bobLog.group.roster).toEqual([]);
      expect(bobLog.next_after_seq).toBeNull();

      const carolLog = await services.groups.getLog(carol.id, group.g, {
        device_key: carolDevice.publicKey
      });
      expect(carolLog.items.map((item) => item.seq)).toEqual([6]);
      expect(carolLog.group.roster.map((row) => row.device_key).sort()).toEqual(
        [aliceDevice.publicKey, carolDevice.publicKey].sort()
      );

      const aliceLog = await services.groups.getLog(alice.id, group.g, {
        device_key: aliceDevice.publicKey,
        after_seq: 1,
        limit: 2
      });
      expect(aliceLog.items.map((item) => item.seq)).toEqual([2, 3]);
      expect(aliceLog.next_after_seq).toBe(3);
      expect(aliceLog.items[1]).toMatchObject({
        roster_remove: [bobDevice.publicKey],
        roster_add: []
      });

      const stranger = aProfile();
      const strangerDevice = await registerDevice(stranger);
      await expectE2eeError(
        services.groups.getLog(stranger.id, group.g, {
          device_key: strangerDevice.publicKey
        }),
        'E2EE_NOT_MEMBER'
      );
      await expectE2eeError(
        services.groups.getLog(stranger.id, group.g, {
          device_key: aliceDevice.publicKey
        }),
        'E2EE_NOT_YOUR_DEVICE'
      );
      const deviceGroups = await services.groups.getDeviceGroups(
        carol.id,
        carolDevice.publicKey
      );
      expect(deviceGroups).toEqual([
        expect.objectContaining({
          group: group.g,
          epoch: 3,
          joined_epoch: 3,
          last_seq: 6
        })
      ]);
    });

    it('notifies roster profiles before and after, and wakes only hinted members', async () => {
      const alice = aProfile();
      const bob = aProfile();
      const aliceDevice = await registerDevice(alice);
      const bobDevice = await registerDevice(bob);
      const group = await createGroup(alice, aliceDevice);
      events = [];
      await commit(alice, group, aliceDevice, {
        rosterAdd: [bobDevice.publicKey]
      });
      const groupEvent = events.find((event) => event.method === 'groupEvent')!;
      expect(new Set(groupEvent.args[0] as string[])).toEqual(
        new Set([alice.id, bob.id])
      );
      expect(events.find((event) => event.method === 'wake')!.args).toEqual([
        group.g,
        [bob.id],
        'added'
      ]);
      events = [];
      await sendMessage(alice, group, aliceDevice, [
        bob.id,
        'outsider',
        alice.id
      ]);
      expect(events.find((event) => event.method === 'wake')!.args).toEqual([
        group.g,
        [bob.id],
        'message'
      ]);
    });

    it('repairs the roster under the current commit key', async () => {
      const alice = aProfile();
      const bob = aProfile();
      const aliceDevice = await registerDevice(alice);
      const bobDevice = await registerDevice(bob);
      const group = await createGroup(alice, aliceDevice);
      await commit(alice, group, aliceDevice, {
        rosterAdd: [bobDevice.publicKey]
      });
      const deviceKeys = [aliceDevice.publicKey];
      const signature = group.keys[1].sign(
        e2eeRosterDigest({ group: group.g, epoch: 1, deviceKeys })
      );
      await expectE2eeError(
        services.groups.repairRoster(alice.id, group.g, {
          epoch: 1,
          device_keys: deviceKeys,
          requester_device_key: aliceDevice.publicKey,
          signature: group.keys[0].sign(
            e2eeRosterDigest({ group: group.g, epoch: 1, deviceKeys })
          )
        }),
        'E2EE_BAD_SIGNATURE'
      );
      const repaired = await services.groups.repairRoster(alice.id, group.g, {
        epoch: 1,
        device_keys: deviceKeys,
        requester_device_key: aliceDevice.publicKey,
        signature
      });
      expect(repaired.roster.map((row) => row.device_key)).toEqual(deviceKeys);
      expect(events.some((event) => event.method === 'rosterChanged')).toBe(
        true
      );
    });
  });

  describe('policy', () => {
    async function claimFor(
      caller: Profile,
      callerDevice: E2eeTestKey,
      target: Profile,
      group?: string
    ) {
      const result = await services.devices.claimKeyPackages(caller.id, {
        targets: [{ profile_id: target.id }],
        claimer_device_key: callerDevice.publicKey,
        group
      });
      return result.results[0];
    }

    it('applies DM policy and blocks at claim and eligibility', async () => {
      const alice = aProfile();
      const aliceDevice = await registerDevice(alice);
      const open = aProfile();
      const picky = aProfile();
      const friend = aProfile();
      const closed = aProfile();
      const blocker = aProfile();
      const blocked = aProfile();
      const empty = aProfile();
      for (const profile of [open, picky, friend, closed, blocker, blocked]) {
        await uploadKeyPackages(profile, await registerDevice(profile), 2);
      }
      await setDmPolicy(picky.id, 'PEOPLE_I_FOLLOW');
      await setDmPolicy(friend.id, 'PEOPLE_I_FOLLOW');
      await follow(friend.id, alice.id);
      await follow(alice.id, picky.id);
      await setDmPolicy(closed.id, 'NOBODY');
      await block(blocker.id, alice.id);
      await block(alice.id, blocked.id);

      const statuses: Record<string, string> = {};
      for (const profile of [
        open,
        picky,
        friend,
        closed,
        blocker,
        blocked,
        empty
      ]) {
        statuses[profile.id] = (
          await claimFor(alice, aliceDevice, profile)
        ).status;
      }
      expect(statuses).toEqual({
        [open.id]: 'OK',
        [picky.id]: 'POLICY',
        [friend.id]: 'OK',
        [closed.id]: 'POLICY',
        [blocker.id]: 'BLOCKED',
        [blocked.id]: 'BLOCKED',
        [empty.id]: 'NO_DEVICES'
      });
      const eligibility = await services.devices.checkEligibility(alice.id, {
        profile_ids: [open.id, closed.id, alice.id]
      });
      expect(eligibility.results).toEqual([
        { profile_id: open.id, status: 'OK', active_devices: 1 },
        { profile_id: closed.id, status: 'POLICY', active_devices: 1 },
        { profile_id: alice.id, status: 'OK', active_devices: 1 }
      ]);
    });

    it('lets profiles already in the group bypass policy at claim and roster_add', async () => {
      const alice = aProfile();
      const bob = aProfile();
      const aliceDevice = await registerDevice(alice);
      const bobDevice = await registerDevice(bob);
      const group = await createGroup(alice, aliceDevice);
      await commit(alice, group, aliceDevice, {
        rosterAdd: [bobDevice.publicKey]
      });
      await setDmPolicy(bob.id, 'NOBODY');
      const bobPhone = await registerDevice(bob);
      await uploadKeyPackages(bob, bobPhone, 1);
      expect((await claimFor(alice, aliceDevice, bob)).status).toBe('POLICY');
      const bypassed = await claimFor(alice, aliceDevice, bob, group.g);
      expect(bypassed.status).toBe('OK');
      expect(bypassed.key_packages.map((kp) => kp.device.device_key)).toEqual([
        bobPhone.publicKey
      ]);
      await commit(alice, group, aliceDevice, {
        rosterAdd: [bobPhone.publicKey]
      });

      const carol = aProfile();
      const carolDevice = await registerDevice(carol);
      await setDmPolicy(carol.id, 'NOBODY');
      await expectE2eeError(
        commit(alice, group, aliceDevice, {
          rosterAdd: [carolDevice.publicKey]
        }),
        'E2EE_POLICY'
      );
      const dave = aProfile();
      const daveDevice = await registerDevice(dave);
      await block(dave.id, alice.id);
      await expectE2eeError(
        commit(alice, group, aliceDevice, {
          rosterAdd: [daveDevice.publicKey]
        }),
        'E2EE_BLOCKED'
      );
    });
  });

  describe('key packages', () => {
    it('pops one-time KeyPackages FIFO, then the last resort, never for revoked devices', async () => {
      const alice = aProfile();
      const bob = aProfile();
      const aliceDevice = await registerDevice(alice);
      const bobDevice = await registerDevice(bob);
      await uploadKeyPackages(bob, bobDevice, 2, true);
      const claim = () =>
        services.devices.claimKeyPackages(alice.id, {
          targets: [{ profile_id: bob.id }],
          claimer_device_key: aliceDevice.publicKey
        });
      const decode = (value: string) => Buffer.from(value, 'base64').toString();
      const first = (await claim()).results[0].key_packages[0];
      expect(decode(first.key_package)).toBe(`kp-${bobDevice.publicKey}-0`);
      expect(first.last_resort).toBe(false);
      const second = (await claim()).results[0].key_packages[0];
      expect(decode(second.key_package)).toBe(`kp-${bobDevice.publicKey}-1`);
      const third = (await claim()).results[0].key_packages[0];
      expect(third.last_resort).toBe(true);
      expect(decode(third.key_package)).toBe(
        `last-resort-${bobDevice.publicKey}`
      );
      const status = (await services.devices.getMe(bob.id)).key_packages[0];
      expect(status.one_time_available).toBe(0);
      expect(status.last_resort_expires_at).toBe(nowSeconds() + 90 * 86400);
      await expectE2eeError(
        uploadKeyPackages(bob, bobDevice, 101),
        'E2EE_KEY_PACKAGE_LIMIT'
      );
      await uploadKeyPackages(bob, bobDevice, 100);
      await expectE2eeError(
        uploadKeyPackages(bob, bobDevice, 1),
        'E2EE_KEY_PACKAGE_LIMIT'
      );

      const revokedAt = nowSeconds();
      await services.devices.revokeDevice(bob.id, bobDevice.publicKey, {
        revoker_device_key: bobDevice.publicKey,
        revoked_at: revokedAt,
        signature: bobDevice.sign(
          e2eeRevokeDigest({
            targetDeviceKey: bobDevice.publicKey,
            revokerDeviceKey: bobDevice.publicKey,
            revokedAtSeconds: revokedAt
          })
        )
      });
      expect((await claim()).results[0]).toEqual({
        profile_id: bob.id,
        status: 'NO_DEVICES',
        key_packages: []
      });
    });
  });

  describe('welcomes and revocation', () => {
    it('delivers a welcome once per target until acknowledged', async () => {
      const alice = aProfile();
      const bob = aProfile();
      const aliceDevice = await registerDevice(alice);
      const bobDevice = await registerDevice(bob);
      const group = await createGroup(alice, aliceDevice);
      await expectE2eeError(
        commit(alice, group, aliceDevice, {
          rosterAdd: [bobDevice.publicKey],
          welcomeTargets: [aliceDevice.publicKey]
        }),
        'E2EE_BAD_REQUEST'
      );
      await commit(alice, group, aliceDevice, {
        rosterAdd: [bobDevice.publicKey],
        welcomeTargets: [bobDevice.publicKey]
      });
      expect(
        events.find((event) => event.method === 'welcomes')!.args[0]
      ).toEqual([
        expect.objectContaining({
          profileId: bob.id,
          deviceKey: bobDevice.publicKey,
          group: group.g
        })
      ]);
      const welcomes = await services.groups.getWelcomes(
        bob.id,
        bobDevice.publicKey
      );
      expect(welcomes).toEqual([
        expect.objectContaining({
          group: group.g,
          epoch: 1,
          added_by_profile_id: alice.id,
          added_by_device_key: aliceDevice.publicKey,
          ratchet_tree: null
        })
      ]);
      expect(Buffer.from(welcomes[0].data, 'base64')).toHaveLength(300);
      await expect(
        services.groups.ackWelcome(bob.id, bobDevice.publicKey, welcomes[0].id)
      ).resolves.toEqual({});
      expect(
        await services.groups.getWelcomes(bob.id, bobDevice.publicKey)
      ).toEqual([]);
      const leftover = await sqlExecutor.execute(
        `select id from e2ee_welcomes where id = :id`,
        { id: welcomes[0].id }
      );
      expect(leftover).toEqual([]);
    });

    it('gives a welcome what the entry leaves of the shared budget', async () => {
      const alice = aProfile();
      const bob = aProfile();
      const carol = aProfile();
      const aliceDevice = await registerDevice(alice);
      const bobDevice = await registerDevice(bob);
      const carolDevice = await registerDevice(carol);
      const group = await createGroup(alice, aliceDevice);
      // Beside a 2 MiB entry the welcome keeps 1.25 MiB.
      const maxEntry = E2EE_ENTRY_BUCKETS.at(-1)!;
      await expectE2eeError(
        commit(alice, group, aliceDevice, {
          rosterAdd: [bobDevice.publicKey],
          welcomeTargets: [bobDevice.publicKey],
          entryBytes: maxEntry,
          welcomeBytes: E2EE_MAX_ENTRY_AND_WELCOME_BYTES - maxEntry + 1
        }),
        'E2EE_TOO_LARGE'
      );
      await commit(alice, group, aliceDevice, {
        rosterAdd: [bobDevice.publicKey],
        welcomeTargets: [bobDevice.publicKey],
        entryBytes: maxEntry,
        welcomeBytes: E2EE_MAX_ENTRY_AND_WELCOME_BYTES - maxEntry
      });
      // Beside a small entry an X-Wing welcome of 3 MiB fits.
      await commit(alice, group, aliceDevice, {
        rosterAdd: [carolDevice.publicKey],
        welcomeTargets: [carolDevice.publicKey],
        welcomeBytes: E2EE_MAX_ENTRY_AND_WELCOME_BYTES - 2048
      });
      const [welcome] = await services.groups.getWelcomes(
        carol.id,
        carolDevice.publicKey
      );
      expect(Buffer.from(welcome.data, 'base64')).toHaveLength(
        E2EE_MAX_ENTRY_AND_WELCOME_BYTES - 2048
      );
    });

    it('revokes a device everywhere with a verified signature', async () => {
      const alice = aProfile();
      const bob = aProfile();
      const aliceDevice = await registerDevice(alice);
      const bobLaptop = await registerDevice(bob);
      const bobPhone = await registerDevice(bob);
      await uploadKeyPackages(bob, bobPhone, 3);
      const group = await createGroup(alice, aliceDevice);
      await commit(alice, group, aliceDevice, {
        rosterAdd: [bobLaptop.publicKey, bobPhone.publicKey],
        welcomeTargets: [bobPhone.publicKey]
      });
      const revokedAt = nowSeconds();
      const digest = e2eeRevokeDigest({
        targetDeviceKey: bobPhone.publicKey,
        revokerDeviceKey: bobLaptop.publicKey,
        revokedAtSeconds: revokedAt
      });
      await expectE2eeError(
        services.devices.revokeDevice(bob.id, bobPhone.publicKey, {
          revoker_device_key: bobLaptop.publicKey,
          revoked_at: revokedAt,
          signature: bobPhone.sign(digest)
        }),
        'E2EE_BAD_SIGNATURE'
      );
      await expectE2eeError(
        services.devices.revokeDevice(alice.id, bobPhone.publicKey, {
          revoker_device_key: aliceDevice.publicKey,
          revoked_at: revokedAt,
          signature: aliceDevice.sign(digest)
        }),
        'E2EE_NOT_YOUR_DEVICE'
      );
      events = [];
      const revoked = await services.devices.revokeDevice(
        bob.id,
        bobPhone.publicKey,
        {
          revoker_device_key: bobLaptop.publicKey,
          revoked_at: revokedAt,
          signature: bobLaptop.sign(digest)
        }
      );
      expect(revoked.revocation).toEqual({
        revoker_device_key: bobLaptop.publicKey,
        revoked_at: revokedAt,
        signature: bobLaptop.sign(digest)
      });
      const revokedEvent = events.find(
        (event) => event.method === 'deviceRevoked'
      )!;
      expect(new Set(revokedEvent.args[0] as string[])).toEqual(
        new Set([alice.id, bob.id])
      );
      const roster = await services.groups.getGroup(
        alice.id,
        group.g,
        aliceDevice.publicKey
      );
      expect(roster.roster.map((row) => row.device_key).sort()).toEqual(
        [aliceDevice.publicKey, bobLaptop.publicKey].sort()
      );
      expect(
        await db.countOneTimeKeyPackages(bobPhone.publicKey, nowSeconds())
      ).toBe(0);
      const deliveries = await sqlExecutor.execute(
        `select * from e2ee_welcome_deliveries where device_key = :d`,
        { d: bobPhone.publicKey }
      );
      expect(deliveries).toEqual([]);
      await expectE2eeError(
        services.groups.getWelcomes(bob.id, bobPhone.publicKey),
        'E2EE_NOT_YOUR_DEVICE'
      );
      const again = await services.devices.revokeDevice(
        bob.id,
        bobPhone.publicKey,
        {
          revoker_device_key: bobLaptop.publicKey,
          revoked_at: revokedAt,
          signature: bobLaptop.sign(digest)
        }
      );
      expect(again.revoked_at).toBe(revoked.revoked_at);
    });
  });

  describe('blobs and reports', () => {
    it('stores attachments for group members only', async () => {
      const alice = aProfile();
      const bob = aProfile();
      const aliceDevice = await registerDevice(alice);
      const bobDevice = await registerDevice(bob);
      const group = await createGroup(alice, aliceDevice);
      await expectE2eeError(
        services.blobs.createBlob(bob.id, {
          group: group.g,
          uploader_device_key: bobDevice.publicKey,
          size: 10,
          chunk_count: 1
        }),
        'E2EE_NOT_MEMBER'
      );
      const blob = await services.blobs.createBlob(alice.id, {
        group: group.g,
        uploader_device_key: aliceDevice.publicKey,
        size: 30,
        chunk_count: 2
      });
      const chunk0 = randomBytes(20);
      const chunk1 = randomBytes(10);
      await services.blobs.putChunk(alice.id, blob.blob_id, 0, {
        data: chunk0.toString('base64')
      });
      await expectE2eeError(
        services.blobs.completeBlob(alice.id, blob.blob_id),
        'E2EE_BAD_REQUEST'
      );
      await expectE2eeError(
        services.blobs.putChunk(bob.id, blob.blob_id, 1, {
          data: chunk1.toString('base64')
        }),
        'E2EE_FORBIDDEN'
      );
      await services.blobs.putChunk(alice.id, blob.blob_id, 1, {
        data: chunk1.toString('base64')
      });
      await expectE2eeError(
        services.blobs.getChunk(
          alice.id,
          blob.blob_id,
          0,
          aliceDevice.publicKey
        ),
        'E2EE_NOT_FOUND'
      );
      const completed = await services.blobs.completeBlob(
        alice.id,
        blob.blob_id
      );
      expect(completed.complete).toBe(true);
      const downloaded = await services.blobs.getChunk(
        alice.id,
        blob.blob_id,
        1,
        aliceDevice.publicKey
      );
      expect(Buffer.from(downloaded.data, 'base64').equals(chunk1)).toBe(true);
      await expectE2eeError(
        services.blobs.getChunk(bob.id, blob.blob_id, 0, bobDevice.publicKey),
        'E2EE_NOT_MEMBER'
      );
      await commit(alice, group, aliceDevice, {
        rosterAdd: [bobDevice.publicKey]
      });
      await commit(alice, group, aliceDevice, {
        rosterRemove: [bobDevice.publicKey]
      });
      const afterRemoval = await services.blobs.getChunk(
        bob.id,
        blob.blob_id,
        0,
        bobDevice.publicKey
      );
      expect(Buffer.from(afterRemoval.data, 'base64').equals(chunk0)).toBe(
        true
      );
    });

    it('keeps S3 attachment bytes out of MySQL and deletes them at retention', async () => {
      blobEnv = S3_BLOB_ENV;
      const alice = aProfile();
      const aliceDevice = await registerDevice(alice);
      const group = await createGroup(alice, aliceDevice);
      const blob = await services.blobs.createBlob(alice.id, {
        group: group.g,
        uploader_device_key: aliceDevice.publicKey,
        size: 30,
        chunk_count: 2
      });
      const chunk0 = randomBytes(20);
      const chunk1 = randomBytes(10);
      await services.blobs.putChunk(alice.id, blob.blob_id, 0, {
        data: chunk0.toString('base64')
      });
      await services.blobs.putChunk(alice.id, blob.blob_id, 1, {
        data: chunk1.toString('base64')
      });
      await services.blobs.completeBlob(alice.id, blob.blob_id);
      const stored = s3.objects.get(`${BLOB_PREFIX}/${blob.blob_id}/0`);
      expect(stored?.body.equals(chunk0)).toBe(true);
      expect(stored?.input.ServerSideEncryption).toBe('AES256');
      expect(stored?.input.ACL).toBeUndefined();
      const rows = await sqlExecutor.execute<{
        storage: string;
        size: number;
        bytes: number;
      }>(
        `select b.storage, c.size, length(c.data) as bytes
         from e2ee_blobs b join e2ee_blob_chunks c on c.blob_id = b.blob_id
         where b.blob_id = :blobId order by c.chunk_index`,
        { blobId: blob.blob_id }
      );
      expect(
        rows.map((row) => [row.storage, Number(row.size), Number(row.bytes)])
      ).toEqual([
        ['s3', 20, 0],
        ['s3', 10, 0]
      ]);
      const downloaded = await services.blobs.getChunk(
        alice.id,
        blob.blob_id,
        1,
        aliceDevice.publicKey
      );
      expect(Buffer.from(downloaded.data, 'base64').equals(chunk1)).toBe(true);

      // Switching back to MySQL changes new blobs only.
      blobEnv = { ...S3_BLOB_ENV, E2EE_BLOB_STORE: 'mysql' };
      const again = await services.blobs.getChunk(
        alice.id,
        blob.blob_id,
        0,
        aliceDevice.publicKey
      );
      expect(Buffer.from(again.data, 'base64').equals(chunk0)).toBe(true);

      // A missing object is a missing chunk, not a server error.
      s3.objects.delete(`${BLOB_PREFIX}/${blob.blob_id}/0`);
      await expectE2eeError(
        services.blobs.getChunk(
          alice.id,
          blob.blob_id,
          0,
          aliceDevice.publicKey
        ),
        'E2EE_NOT_FOUND'
      );

      // Without its S3 settings an S3 blob fails closed.
      blobEnv = {};
      await expectE2eeError(
        services.blobs.getChunk(
          alice.id,
          blob.blob_id,
          1,
          aliceDevice.publicKey
        ),
        'E2EE_STORAGE_UNAVAILABLE'
      );

      // While S3 is unavailable, retention keeps the rows (no orphans).
      now += 366 * DAY;
      await pruneE2eeBlobs(deps);
      expect(s3.objects.size).toBe(1);
      const countRows = async () => {
        const [{ blobs }] = await sqlExecutor.execute<{ blobs: number }>(
          `select count(*) as blobs from e2ee_blobs where blob_id = :blobId`,
          { blobId: blob.blob_id }
        );
        return Number(blobs);
      };
      expect(await countRows()).toBe(1);

      // Retention deletes the objects first, then the rows.
      blobEnv = S3_BLOB_ENV;
      await pruneE2eeBlobs(deps);
      expect(s3.objects.size).toBe(0);
      expect(await countRows()).toBe(0);
    });

    it('keeps the row of a blob the migration moved while retention ran', async () => {
      const alice = aProfile();
      const aliceDevice = await registerDevice(alice);
      const group = await createGroup(alice, aliceDevice);
      const blob = await services.blobs.createBlob(alice.id, {
        group: group.g,
        uploader_device_key: aliceDevice.publicKey,
        size: 4,
        chunk_count: 1
      });
      await services.blobs.putChunk(alice.id, blob.blob_id, 0, {
        data: randomBytes(4).toString('base64')
      });
      await services.blobs.completeBlob(alice.id, blob.blob_id);
      now += 366 * DAY;
      let passes = 0;
      const deleted = await db.pruneExpiredBlobs(now, 5, async (expired) => {
        if (passes++ > 0) return []; // the S3 pass cannot delete here
        // The migration switches the blob between retention's select and
        // its row delete: the row now names objects that must survive.
        await sqlExecutor.execute(
          `update e2ee_blobs set storage = 's3', storage_location = :location
           where blob_id = :blobId`,
          {
            location: `s3://${BLOB_BUCKET}/${BLOB_PREFIX}`,
            blobId: blob.blob_id
          }
        );
        return expired.map((row) => row.blob_id);
      });
      expect(deleted).toBe(0);
      const [{ blobs }] = await sqlExecutor.execute<{ blobs: number }>(
        `select count(*) as blobs from e2ee_blobs where blob_id = :blobId`,
        { blobId: blob.blob_id }
      );
      expect(Number(blobs)).toBe(1);
    });

    it('migrates complete MySQL blobs to S3 after verifying them', async () => {
      const alice = aProfile();
      const aliceDevice = await registerDevice(alice);
      const group = await createGroup(alice, aliceDevice);
      const blob = await services.blobs.createBlob(alice.id, {
        group: group.g,
        uploader_device_key: aliceDevice.publicKey,
        size: 15,
        chunk_count: 2
      });
      const chunks = [randomBytes(9), randomBytes(6)];
      for (let index = 0; index < chunks.length; index++) {
        await services.blobs.putChunk(alice.id, blob.blob_id, index, {
          data: chunks[index].toString('base64')
        });
      }
      await services.blobs.completeBlob(alice.id, blob.blob_id);
      const target = new S3E2eeBlobStore(
        { bucket: BLOB_BUCKET, prefix: BLOB_PREFIX, region: 'eu-west-1' },
        s3,
        db
      );
      const dryRun = await migrateE2eeBlobsToS3(
        { db, target },
        { live: false, limit: 1000, now: () => now }
      );
      expect(dryRun.mode).toBe('dry-run');
      expect(dryRun.migrated).toBeGreaterThanOrEqual(1);
      expect(s3.objects.size).toBe(0);
      const live = await migrateE2eeBlobsToS3(
        { db, target },
        { live: true, limit: 1000, now: () => now }
      );
      expect(live.failures).toEqual([]);
      expect(
        s3.objects
          .get(`${BLOB_PREFIX}/${blob.blob_id}/1`)
          ?.body.equals(chunks[1])
      ).toBe(true);
      const [row] = await sqlExecutor.execute<{
        storage: string;
        bytes: number;
      }>(
        `select b.storage, coalesce(sum(length(c.data)), 0) as bytes
         from e2ee_blobs b join e2ee_blob_chunks c on c.blob_id = b.blob_id
         where b.blob_id = :blobId group by b.storage`,
        { blobId: blob.blob_id }
      );
      expect([row.storage, Number(row.bytes)]).toEqual(['s3', 0]);
      const [located] = await sqlExecutor.execute<{
        storage_location: string;
      }>(`select storage_location from e2ee_blobs where blob_id = :blobId`, {
        blobId: blob.blob_id
      });
      expect(located.storage_location).toBe(
        `s3://${BLOB_BUCKET}/${BLOB_PREFIX}`
      );
      blobEnv = S3_BLOB_ENV;
      const downloaded = await services.blobs.getChunk(
        alice.id,
        blob.blob_id,
        0,
        aliceDevice.publicKey
      );
      expect(Buffer.from(downloaded.data, 'base64').equals(chunks[0])).toBe(
        true
      );
      const rerun = await migrateE2eeBlobsToS3(
        { db, target },
        { live: true, limit: 1000, now: () => now }
      );
      expect(rerun.examined).toBe(0);
    });

    it('bounds attachment storage per profile and prunes abandoned uploads', async () => {
      const alice = aProfile();
      const aliceDevice = await registerDevice(alice);
      const group = await createGroup(alice, aliceDevice);
      const create = (size: number) =>
        services.blobs.createBlob(alice.id, {
          group: group.g,
          uploader_device_key: aliceDevice.publicKey,
          size,
          chunk_count: 25
        });
      const small = await services.blobs.createBlob(alice.id, {
        group: group.g,
        uploader_device_key: aliceDevice.publicKey,
        size: 10,
        chunk_count: 1
      });
      await expectE2eeError(
        services.blobs.putChunk(alice.id, small.blob_id, 0, {
          data: randomBytes(11).toString('base64')
        }),
        'E2EE_TOO_LARGE'
      );
      const max = 25 * (1024 * 1024 + 16);
      await expectE2eeError(create(max + 1), 'E2EE_TOO_LARGE');
      for (let i = 0; i < 7; i++) await create(max);
      // 7 x (25 MiB + 400 B) + 10 B leaves less than 25 MiB of the 200 MiB day.
      await expectE2eeError(create(max), 'E2EE_RATE_LIMITED');
      now += 25 * 60 * 60 * 1000;
      await create(max);
      const abandoned = await sqlExecutor.execute(
        `select blob_id from e2ee_blobs where uploader_profile_id = :p and complete = false`,
        { p: alice.id }
      );
      // Incomplete uploads older than 24 h are pruned on the next upload.
      expect(abandoned).toHaveLength(8 - 5 + 1);
      for (let i = 0; i < 41; i++) {
        await db.insertBlob({
          blob_id: `0x${randomBytes(16).toString('hex')}`,
          group_handle: group.g,
          uploader_device_key: aliceDevice.publicKey,
          uploader_profile_id: alice.id,
          size: max,
          chunk_count: 25,
          complete: true,
          created_at: now - 2 * DAY,
          completed_at: now - 2 * DAY
        });
      }
      await expectE2eeError(create(max), 'E2EE_TOO_LARGE');
    });

    it('verifies the inner signature of a reported message', async () => {
      const alice = aProfile();
      const bob = aProfile();
      const aliceDevice = await registerDevice(alice);
      const bobDevice = await registerDevice(bob);
      const group = await createGroup(alice, aliceDevice);
      await commit(alice, group, aliceDevice, {
        rosterAdd: [bobDevice.publicKey]
      });
      const body = Buffer.from(
        JSON.stringify({ v: 1, t: 'msg', text: 'spam' })
      );
      const sig64 = aliceDevice.sign(
        e2eeMessageDigest({ group: group.g, epoch: 1, body })
      );
      const report = await services.blobs.report(bob.id, {
        group: group.g,
        epoch: 1,
        body: body.toString('base64'),
        signature: sig64,
        sender_device_key: aliceDevice.publicKey,
        reporter_device_key: bobDevice.publicKey,
        reason: ApiE2eeReportCategory.CredibleThreatOfViolence
      });
      expect(report).toMatchObject({
        verified: true,
        sender_profile_id: alice.id
      });
      const tampered = await services.blobs.report(bob.id, {
        group: group.g,
        epoch: 1,
        body: Buffer.from('{"v":1,"t":"msg","text":"edited"}').toString(
          'base64'
        ),
        signature: sig64,
        sender_device_key: aliceDevice.publicKey,
        reporter_device_key: bobDevice.publicKey,
        reason: ApiE2eeReportCategory.CredibleThreatOfViolence,
        notes: 'not what was sent'
      });
      expect(tampered.verified).toBe(false);
    });
  });

  describe('attachments switch', () => {
    it('refuses every blob route and stores nothing while attachments are off', async () => {
      const alice = aProfile();
      const aliceDevice = await registerDevice(alice);
      const group = await createGroup(alice, aliceDevice);
      expect((await services.devices.getMe(alice.id)).attachments_enabled).toBe(
        true
      );
      const blob = await services.blobs.createBlob(alice.id, {
        group: group.g,
        uploader_device_key: aliceDevice.publicKey,
        size: 10,
        chunk_count: 1
      });
      attachmentsEnabled = false;
      expect((await services.devices.getMe(alice.id)).attachments_enabled).toBe(
        false
      );
      await expectE2eeError(
        services.blobs.createBlob(alice.id, {
          group: group.g,
          uploader_device_key: aliceDevice.publicKey,
          size: 10,
          chunk_count: 1
        }),
        'E2EE_ATTACHMENTS_DISABLED'
      );
      await expectE2eeError(
        services.blobs.putChunk(alice.id, blob.blob_id, 0, {
          data: randomBytes(10).toString('base64')
        }),
        'E2EE_ATTACHMENTS_DISABLED'
      );
      await expectE2eeError(
        services.blobs.completeBlob(alice.id, blob.blob_id),
        'E2EE_ATTACHMENTS_DISABLED'
      );
      await expectE2eeError(
        services.blobs.getChunk(
          alice.id,
          blob.blob_id,
          0,
          aliceDevice.publicKey
        ),
        'E2EE_ATTACHMENTS_DISABLED'
      );
      const [{ blobs }] = await sqlExecutor.execute<{ blobs: number }>(
        `select count(*) as blobs from e2ee_blobs`
      );
      const [{ chunks }] = await sqlExecutor.execute<{ chunks: number }>(
        `select count(*) as chunks from e2ee_blob_chunks`
      );
      expect(Number(blobs)).toBe(1);
      expect(Number(chunks)).toBe(0);
    });
  });

  describe('trust and safety review', () => {
    async function fileReport(): Promise<{ id: string; senderId: string }> {
      const alice = aProfile();
      const bob = aProfile();
      const aliceDevice = await registerDevice(alice);
      const bobDevice = await registerDevice(bob);
      const group = await createGroup(alice, aliceDevice);
      await commit(alice, group, aliceDevice, {
        rosterAdd: [bobDevice.publicKey]
      });
      const body = Buffer.from(
        JSON.stringify({ v: 1, t: 'msg', text: 'a credible threat' })
      );
      const report = await services.blobs.report(bob.id, {
        group: group.g,
        epoch: 1,
        body: body.toString('base64'),
        signature: aliceDevice.sign(
          e2eeMessageDigest({ group: group.g, epoch: 1, body })
        ),
        sender_device_key: aliceDevice.publicKey,
        reporter_device_key: bobDevice.publicKey,
        reason: ApiE2eeReportCategory.CredibleThreatOfViolence
      });
      return { id: report.id, senderId: alice.id };
    }

    function reviewService(groupId: string | null, members: string[]) {
      return new E2eeTrustAndSafetyService({
        db,
        now: () => now,
        groupId: () => groupId,
        isGroupMember: async (profileId, group) =>
          group === groupId && members.includes(profileId)
      });
    }

    it('lets only the configured group read reports and audits every read', async () => {
      const { id, senderId } = await fileReport();
      await expectE2eeError(
        reviewService(null, ['reviewer']).listReports('reviewer', {}),
        'E2EE_FORBIDDEN'
      );
      await expectE2eeError(
        reviewService('ts-group', ['reviewer']).getReport('stranger', id),
        'E2EE_FORBIDDEN'
      );
      expect(await db.listReportAccess()).toEqual([]);

      const review = reviewService('ts-group', ['reviewer']);
      const page = await review.listReports('reviewer', { limit: 10 });
      expect(page.next_before).toBeNull();
      expect(page.items).toEqual([
        expect.objectContaining({
          id,
          category: ApiE2eeReportCategory.CredibleThreatOfViolence,
          verified: true,
          sender_profile_id: senderId,
          on_hold: false,
          expires_at: START + 180 * 24 * 60 * 60 * 1000
        })
      ]);
      expect(
        JSON.parse(Buffer.from(page.items[0].body, 'base64').toString('utf8'))
      ).toMatchObject({ text: 'a credible threat' });
      const one = await review.getReport('reviewer', id);
      expect(one.id).toBe(id);
      await expectE2eeError(
        review.getReport('reviewer', `0x${'0'.repeat(32)}`),
        'E2EE_NOT_FOUND'
      );
      expect(
        (await db.listReportAccess()).map((row) => ({
          viewer: row.viewer_profile_id,
          action: row.action,
          ids: row.report_ids
        }))
      ).toEqual([
        { viewer: 'reviewer', action: 'list', ids: id },
        { viewer: 'reviewer', action: 'read', ids: id }
      ]);
    });

    it('pages reports that share a timestamp without skipping or repeating any', async () => {
      const ids: string[] = [];
      for (let index = 0; index < 5; index += 1) {
        ids.push((await fileReport()).id);
      }
      const review = reviewService('ts-group', ['reviewer']);
      const all = await review.listReports('reviewer', { limit: 100 });
      expect(new Set(all.items.map((item) => item.created_at)).size).toBe(1);
      const expected = all.items.map((item) => item.id);
      expect([...expected].sort()).toEqual([...ids].sort());

      const seen: string[] = [];
      let cursor: { before?: number; before_id?: string } = {};
      for (let pageNo = 0; pageNo < 10; pageNo += 1) {
        const page = await review.listReports('reviewer', {
          ...cursor,
          limit: 2
        });
        seen.push(...page.items.map((item) => item.id));
        if (page.next_before === null) {
          expect(page.next_before_id).toBeNull();
          break;
        }
        cursor = {
          before: page.next_before,
          before_id: page.next_before_id!
        };
      }
      expect(seen).toEqual(expected);
    });

    it('commits a hold change only together with its audit row', async () => {
      const { id } = await fileReport();
      const failingAudit = new E2eeTrustAndSafetyService({
        db: {
          listReportsForReview: db.listReportsForReview.bind(db),
          getReportForReview: db.getReportForReview.bind(db),
          setReportHold: db.setReportHold.bind(db),
          executeNativeQueriesInTransaction:
            db.executeNativeQueriesInTransaction.bind(db),
          insertReportAccess: async () => {
            throw new Error('audit log unavailable');
          }
        },
        now: () => now,
        groupId: () => 'ts-group',
        isGroupMember: async () => true
      });
      await expect(failingAudit.setHold('reviewer', id, true)).rejects.toThrow(
        'audit log unavailable'
      );
      expect((await db.getReportForReview(id))?.on_hold).toBeFalsy();
      await expectE2eeError(
        reviewService('ts-group', ['reviewer']).setHold(
          'reviewer',
          `0x${'0'.repeat(32)}`,
          true
        ),
        'E2EE_NOT_FOUND'
      );
      expect(await db.listReportAccess()).toEqual([]);
    });

    it('deletes reports after 180 days unless they are on hold', async () => {
      const kept = await fileReport();
      const expired = await fileReport();
      const review = reviewService('ts-group', ['reviewer']);
      const held = await review.setHold('reviewer', kept.id, true);
      expect(held).toMatchObject({ on_hold: true, expires_at: null });
      now = START + 181 * 24 * 60 * 60 * 1000;
      await db.pruneExpiredReports(now, 100);
      const remaining = await review.listReports('reviewer', {});
      expect(remaining.items.map((item) => item.id)).toEqual([kept.id]);
      expect(await db.getReportForReview(expired.id)).toBeNull();
      const released = await review.setHold('reviewer', kept.id, false);
      expect(released.on_hold).toBe(false);
      await db.pruneExpiredReports(now, 100);
      expect(await db.getReportForReview(kept.id)).toBeNull();
      expect((await db.listReportAccess()).map((row) => row.action)).toEqual([
        'hold',
        'list',
        'release'
      ]);
    });
  });

  describe('throttles, limits and retention', () => {
    it('allows one wake per profile and group per 60 seconds', async () => {
      const g = randomE2eeGroupHandle();
      expect(await db.claimPushWakes(g, ['a', 'b'], START)).toEqual(['a', 'b']);
      expect(await db.claimPushWakes(g, ['a', 'c'], START + 59_000)).toEqual([
        'c'
      ]);
      expect(await db.claimPushWakes(g, ['a'], START + 60_000)).toEqual(['a']);
      expect(
        await db.claimPushWakes(randomE2eeGroupHandle(), ['a'], START + 60_001)
      ).toEqual(['a']);
    });

    it('counts fixed windows and resets them', async () => {
      const key = { key: 'test:subject', windowStart: START };
      expect((await db.hitRateCounters([key])).get('test:subject')).toBe(1);
      expect((await db.hitRateCounters([key])).get('test:subject')).toBe(2);
      expect(
        (
          await db.hitRateCounters([{ ...key, windowStart: START + 60_000 }])
        ).get('test:subject')
      ).toBe(1);
    });

    it('prunes expired messages opportunistically', async () => {
      const alice = aProfile();
      const device = await registerDevice(alice);
      const group = await createGroup(alice, device);
      await sendMessage(alice, group, device);
      now += 91 * DAY;
      randomValue = 0;
      await sendMessage(alice, group, device);
      const rows = await sqlExecutor.execute<{ seq: number }>(
        `select seq from ${E2EE_LOG_TABLE} where group_handle = :g order by seq`,
        { g: group.g }
      );
      expect(rows.map((row) => Number(row.seq))).toEqual([2]);
    });
  });
});
