import { keccak256 } from 'ethers';
import {
  E2eeServiceDeps,
  enforceE2eeByteBudget,
  enforceE2eeRateLimit,
  isActiveDevice,
  maybePruneE2ee,
  nowSeconds,
  requireOwnActiveDevice
} from '@/api/e2ee/e2ee-context';
import { E2eeWelcomeEventData } from '@/api/e2ee/e2ee-events';
import { toApiE2eeGroup, toApiE2eeLogItem } from '@/api/e2ee/e2ee.mappers';
import { ApiE2eeCreateGroupRequest } from '@/api/generated/models/ApiE2eeCreateGroupRequest';
import { ApiE2eeDeviceGroup } from '@/api/generated/models/ApiE2eeDeviceGroup';
import { ApiE2eeGroup } from '@/api/generated/models/ApiE2eeGroup';
import { ApiE2eeLogItem } from '@/api/generated/models/ApiE2eeLogItem';
import { ApiE2eeLogPage } from '@/api/generated/models/ApiE2eeLogPage';
import { ApiE2eeRosterRepairRequest } from '@/api/generated/models/ApiE2eeRosterRepairRequest';
import { ApiE2eeSendMessageRequest } from '@/api/generated/models/ApiE2eeSendMessageRequest';
import { ApiE2eeSendMessageResponse } from '@/api/generated/models/ApiE2eeSendMessageResponse';
import { ApiE2eeSubmitEntryRequest } from '@/api/generated/models/ApiE2eeSubmitEntryRequest';
import { ApiE2eeWelcome } from '@/api/generated/models/ApiE2eeWelcome';
import {
  E2EE_ENTRY_BUCKETS,
  E2EE_LOG_DEFAULT_LIMIT,
  E2EE_MAX_DEVICE_GROUPS,
  E2EE_MAX_ENTRY_AND_WELCOME_BYTES,
  E2EE_MAX_ENTRY_BYTES,
  E2EE_MAX_MESSAGE_BYTES,
  E2EE_MAX_PROPOSALS_PER_EPOCH,
  E2EE_MAX_ROSTER_DEVICES,
  E2EE_MAX_WELCOMES_PER_PAGE,
  E2EE_MESSAGE_BUCKETS,
  E2EE_PAGE_BYTE_BUDGET,
  E2EE_RATE_LIMITS
} from '@/e2ee/e2ee.constants';
import {
  E2eeDeviceRow,
  E2eeGroupRow,
  E2eeLogMetaRow,
  E2eeRosterRow
} from '@/e2ee/e2ee.db';
import {
  E2eeEntryKind,
  e2eeEntryDigest,
  e2eeRosterDigest,
  verifyE2eeEd25519
} from '@/e2ee/e2ee-digests';
import {
  assertDistinct,
  decodeE2eeBase64,
  isDeadlockError,
  isDuplicateKeyError,
  isE2eeBucketLength,
  isZero32
} from '@/e2ee/e2ee-encoding';
import { e2eeErrors } from '@/e2ee/e2ee-errors';
import { e2eeEntriesPerGroupPerHour } from '@/e2ee/e2ee-flag';
import { decideE2eePolicy, E2eeEligibilityStatus } from '@/e2ee/e2ee-policy';
import { ConnectionWrapper } from '@/sql-executor';

type Conn = ConnectionWrapper<unknown>;

const CREATE_GROUP_ATTEMPTS = 3;

interface DecodedWelcome {
  readonly data: Buffer;
  readonly ratchetTree: Buffer | null;
  readonly targets: string[];
}

interface DecodedEntry {
  readonly kind: E2eeEntryKind;
  readonly data: Buffer;
  readonly rosterAdd: string[];
  readonly rosterRemove: string[];
  readonly welcome: DecodedWelcome | null;
}

interface RosterDelta {
  readonly addDevices: E2eeDeviceRow[];
  readonly removeKeys: string[];
  readonly newProfiles: string[];
}

interface SequencedEntry {
  readonly item: ApiE2eeLogItem;
  readonly profilesBefore: string[];
  readonly profilesAfter: string[];
  readonly welcomes: E2eeWelcomeEventData[];
  readonly newProfiles: string[];
}

function rosterProfiles(roster: readonly E2eeRosterRow[]): string[] {
  return Array.from(new Set(roster.map((row) => row.profile_id)));
}

/** Keep items while the raw byte budget lasts; always at least one. */
function takeWithinBudget<T>(
  rows: readonly T[],
  size: (row: T) => number
): T[] {
  const taken: T[] = [];
  let bytes = 0;
  for (const row of rows) {
    bytes += size(row);
    if (taken.length && bytes > E2EE_PAGE_BYTE_BUDGET) break;
    taken.push(row);
  }
  return taken;
}

export class E2eeGroupsService {
  constructor(private readonly deps: E2eeServiceDeps) {}

  private get db() {
    return this.deps.db;
  }

  // ------------------------------------------------------------- creation

  async createGroup(
    callerProfileId: string,
    request: ApiE2eeCreateGroupRequest
  ): Promise<ApiE2eeGroup> {
    if (isZero32(request.commit_key)) {
      throw e2eeErrors.badRequest('commit_key must not be zero');
    }
    await requireOwnActiveDevice(
      this.deps,
      callerProfileId,
      request.creator_device_key
    );
    await enforceE2eeRateLimit(
      this.deps,
      E2EE_RATE_LIMITS.groupCreationsPerProfile,
      callerProfileId
    );
    const now = this.deps.now();
    // A lock on a handle that does not exist yet is a gap lock, so two
    // creations in the same index gap can deadlock on their inserts. Retry
    // the whole transaction a few times before giving up.
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.db.executeNativeQueriesInTransaction((connection) =>
          this.createGroupInTransaction(
            callerProfileId,
            request,
            now,
            connection
          )
        );
      } catch (error) {
        if (isDeadlockError(error) && attempt < CREATE_GROUP_ATTEMPTS) continue;
        if (!isDuplicateKeyError(error)) throw error;
        const existing = await this.db.getGroup(request.group);
        throw e2eeErrors.epochConflict(Number(existing?.epoch ?? 0));
      }
    }
  }

  private async createGroupInTransaction(
    callerProfileId: string,
    request: ApiE2eeCreateGroupRequest,
    now: number,
    connection: Conn
  ): Promise<ApiE2eeGroup> {
    const existing = await this.db.lockGroup(request.group, connection);
    if (existing) {
      return this.existingCreation(
        callerProfileId,
        request,
        existing,
        connection
      );
    }
    const group: E2eeGroupRow = {
      group_handle: request.group,
      epoch: 0,
      commit_key: request.commit_key,
      last_seq: 0,
      created_by_profile_id: callerProfileId,
      created_at: now,
      updated_at: now
    };
    await this.db.insertGroup(group, connection);
    await this.db.insertGroupEpoch(
      {
        group: request.group,
        epoch: 0,
        commitKey: request.commit_key,
        createdAt: now
      },
      connection
    );
    await this.db.insertRosterRows(
      [
        {
          group_handle: request.group,
          device_key: request.creator_device_key,
          profile_id: callerProfileId,
          joined_epoch: 0,
          added_at: now
        }
      ],
      connection
    );
    return toApiE2eeGroup(
      group,
      await this.db.getCurrentRoster(request.group, connection)
    );
  }

  /** An identical retry returns the record; anything else conflicts. */
  private async existingCreation(
    callerProfileId: string,
    request: ApiE2eeCreateGroupRequest,
    existing: E2eeGroupRow,
    connection: Conn
  ): Promise<ApiE2eeGroup> {
    const roster = await this.db.getCurrentRoster(request.group, connection);
    const identical =
      existing.created_by_profile_id === callerProfileId &&
      Number(existing.epoch) === 0 &&
      existing.commit_key === request.commit_key &&
      roster.some((row) => row.device_key === request.creator_device_key);
    if (!identical) throw e2eeErrors.epochConflict(Number(existing.epoch));
    return toApiE2eeGroup(existing, roster);
  }

  // --------------------------------------------------------------- reads

  /** The device's roster windows in the group; 404 if it never was a member. */
  private async requireMembershipHistory(
    callerProfileId: string,
    group: string,
    deviceKey: string
  ) {
    await requireOwnActiveDevice(this.deps, callerProfileId, deviceKey);
    const groupRow = await this.db.getGroup(group);
    const windows = groupRow
      ? await this.db.getDeviceWindows(group, deviceKey)
      : [];
    if (!groupRow || !windows.length) throw e2eeErrors.notMember();
    const current = windows.some((window) => window.removed_epoch === null);
    return { groupRow, windows, current };
  }

  async getGroup(
    callerProfileId: string,
    group: string,
    deviceKey: string
  ): Promise<ApiE2eeGroup> {
    const { groupRow, current } = await this.requireMembershipHistory(
      callerProfileId,
      group,
      deviceKey
    );
    const roster = current ? await this.db.getCurrentRoster(group) : [];
    return toApiE2eeGroup(groupRow, roster);
  }

  async getLog(
    callerProfileId: string,
    group: string,
    query: { device_key: string; after_seq?: number; limit?: number }
  ): Promise<ApiE2eeLogPage> {
    const { groupRow, windows, current } = await this.requireMembershipHistory(
      callerProfileId,
      group,
      query.device_key
    );
    const limit = query.limit ?? E2EE_LOG_DEFAULT_LIMIT;
    const rows = await this.db.getLogPageMeta({
      group,
      afterSeq: query.after_seq ?? 0,
      windows,
      limit: limit + 1
    });
    const page = takeWithinBudget(rows.slice(0, limit), (row) =>
      Number(row.padded_len)
    );
    const hasMore = rows.length > page.length;
    const data = await this.db.getLogData(
      group,
      page.map((row) => Number(row.seq))
    );
    const roster = current ? await this.db.getCurrentRoster(group) : [];
    return {
      items: page.map((row) =>
        toApiE2eeLogItem(row, data.get(Number(row.seq)) ?? '')
      ),
      next_after_seq: hasMore && page.length ? Number(page.at(-1)?.seq) : null,
      group: toApiE2eeGroup(groupRow, roster)
    };
  }

  async getDeviceGroups(
    callerProfileId: string,
    deviceKey: string
  ): Promise<ApiE2eeDeviceGroup[]> {
    await requireOwnActiveDevice(this.deps, callerProfileId, deviceKey);
    const rows = await this.db.getDeviceCurrentGroups(
      deviceKey,
      E2EE_MAX_DEVICE_GROUPS
    );
    return rows.map((row) => ({
      group: row.group_handle,
      epoch: Number(row.epoch),
      last_seq: Number(row.last_seq),
      joined_epoch: Number(row.joined_epoch),
      updated_at: Number(row.updated_at)
    }));
  }

  // ------------------------------------------------------------- entries

  private decodeWelcome(
    welcome: ApiE2eeSubmitEntryRequest['welcome'],
    rosterAdd: string[],
    entryBytes: number
  ): DecodedWelcome | null {
    if (!welcome) return null;
    // The Welcome gets whatever the entry leaves of the shared budget.
    const budget = E2EE_MAX_ENTRY_AND_WELCOME_BYTES - entryBytes;
    const data = decodeE2eeBase64(welcome.data, 'welcome.data', budget);
    const ratchetTree = welcome.ratchet_tree
      ? decodeE2eeBase64(welcome.ratchet_tree, 'welcome.ratchet_tree', budget)
      : null;
    if (!data.length) throw e2eeErrors.badRequest('welcome.data is empty');
    if (data.length + (ratchetTree?.length ?? 0) > budget) {
      throw e2eeErrors.tooLarge('welcome');
    }
    assertDistinct(welcome.targets, 'welcome.targets');
    const added = new Set(rosterAdd);
    if (welcome.targets.some((target) => !added.has(target))) {
      throw e2eeErrors.badRequest(
        'welcome.targets must be a subset of roster_add'
      );
    }
    return { data, ratchetTree, targets: [...welcome.targets] };
  }

  private decodeEntry(request: ApiE2eeSubmitEntryRequest): DecodedEntry {
    const kind =
      String(request.kind) === 'commit'
        ? E2eeEntryKind.COMMIT
        : E2eeEntryKind.PROPOSAL;
    const data = decodeE2eeBase64(request.data, 'data', E2EE_MAX_ENTRY_BYTES);
    if (!isE2eeBucketLength(data.length, E2EE_ENTRY_BUCKETS)) {
      throw e2eeErrors.badRequest('data length must be an entry bucket size');
    }
    if (keccak256(data) !== request.entry_hash) {
      throw e2eeErrors.badRequest('entry_hash does not match data');
    }
    const rosterAdd = [...(request.roster_add ?? [])];
    const rosterRemove = [...(request.roster_remove ?? [])];
    assertDistinct(rosterAdd, 'roster_add');
    assertDistinct(rosterRemove, 'roster_remove');
    const removed = new Set(rosterRemove);
    if (rosterAdd.some((key) => removed.has(key))) {
      throw e2eeErrors.badRequest(
        'A device cannot be added and removed at once'
      );
    }
    if (kind === E2eeEntryKind.PROPOSAL) {
      if (
        !isZero32(request.epoch_commitment) ||
        !isZero32(request.next_commit_key)
      ) {
        throw e2eeErrors.badRequest(
          'Proposals carry zero epoch_commitment and next_commit_key'
        );
      }
      if (rosterAdd.length || request.welcome) {
        throw e2eeErrors.badRequest('Proposals cannot add devices');
      }
    } else if (
      isZero32(request.next_commit_key) ||
      isZero32(request.epoch_commitment)
    ) {
      throw e2eeErrors.badRequest(
        'Commits declare the next commit key and epoch commitment'
      );
    }
    return {
      kind,
      data,
      rosterAdd,
      rosterRemove,
      welcome: this.decodeWelcome(request.welcome, rosterAdd, data.length)
    };
  }

  /** Signature check under the immutable commit key of the claimed epoch. */
  private async verifyEpochSignature(
    group: string,
    epoch: number,
    digest: string,
    signature: string,
    conflict: (currentEpoch: number) => Error
  ): Promise<void> {
    const commitKey = await this.db.getEpochCommitKey(group, epoch);
    if (!commitKey) {
      const groupRow = await this.db.getGroup(group);
      if (!groupRow) throw e2eeErrors.notFound('Group');
      throw conflict(Number(groupRow.epoch));
    }
    if (!verifyE2eeEd25519(commitKey, digest, signature)) {
      throw e2eeErrors.badSignature('epoch commit key');
    }
  }

  /** Policy (7.1) for profiles that are new to the roster. */
  private async assertPolicyForNewProfiles(
    callerProfileId: string,
    newProfiles: string[],
    connection: Conn
  ): Promise<void> {
    if (!newProfiles.length) return;
    const facts = await this.db.getPolicyFacts(
      callerProfileId,
      newProfiles,
      nowSeconds(this.deps),
      connection
    );
    for (const profileId of newProfiles) {
      const status = decideE2eePolicy({
        callerProfileId,
        facts: facts.get(profileId)!,
        bypass: false
      });
      if (status === E2eeEligibilityStatus.BLOCKED) {
        throw e2eeErrors.blocked(profileId);
      }
      if (status === E2eeEligibilityStatus.POLICY) {
        throw e2eeErrors.policy(profileId);
      }
    }
  }

  /** Effective additions (active devices) and removals against the roster. */
  private async computeRosterDelta(
    callerProfileId: string,
    roster: readonly E2eeRosterRow[],
    addKeys: readonly string[],
    removeKeys: readonly string[],
    connection: Conn
  ): Promise<RosterDelta> {
    const inRoster = new Set(roster.map((row) => row.device_key));
    const toAdd = addKeys.filter((key) => !inRoster.has(key));
    const devices = await this.db.getDevices(toAdd, connection);
    const atSeconds = nowSeconds(this.deps);
    const byKey = new Map(devices.map((device) => [device.device_key, device]));
    const addDevices = toAdd.map((key) => {
      const device = byKey.get(key);
      if (!device || !isActiveDevice(device, atSeconds)) {
        throw e2eeErrors.badRequest(`Device ${key} is not an active device`);
      }
      return device;
    });
    const profilesBefore = new Set(rosterProfiles(roster));
    const newProfiles = Array.from(
      new Set(
        addDevices
          .map((device) => device.profile_id)
          .filter(
            (profileId) =>
              !profilesBefore.has(profileId) && profileId !== callerProfileId
          )
      )
    );
    await this.assertPolicyForNewProfiles(
      callerProfileId,
      newProfiles,
      connection
    );
    const finalSize =
      roster.length +
      addDevices.length -
      removeKeys.filter((key) => inRoster.has(key)).length;
    if (finalSize > E2EE_MAX_ROSTER_DEVICES) {
      throw e2eeErrors.badRequest(
        `A group roster holds at most ${E2EE_MAX_ROSTER_DEVICES} devices`
      );
    }
    return {
      addDevices,
      removeKeys: removeKeys.filter((key) => inRoster.has(key)),
      newProfiles
    };
  }

  private async storeWelcome(
    input: {
      readonly group: string;
      readonly joinEpoch: number;
      readonly welcome: DecodedWelcome;
      readonly callerProfileId: string;
      readonly senderDeviceKey: string;
      readonly profileOf: Map<string, string>;
      readonly now: number;
    },
    connection: Conn
  ): Promise<E2eeWelcomeEventData[]> {
    const welcomeId = this.deps.randomHex(16);
    const targets = input.welcome.targets
      .filter((deviceKey) => input.profileOf.has(deviceKey))
      .map((deviceKey) => ({
        device_key: deviceKey,
        profile_id: input.profileOf.get(deviceKey)!
      }));
    await this.db.insertWelcome(
      {
        id: welcomeId,
        group_handle: input.group,
        epoch: input.joinEpoch,
        data: input.welcome.data,
        ratchet_tree: input.welcome.ratchetTree,
        added_by_profile_id: input.callerProfileId,
        added_by_device_key: input.senderDeviceKey,
        created_at: input.now
      },
      targets,
      connection
    );
    return targets.map((target) => ({
      profileId: target.profile_id,
      deviceKey: target.device_key,
      welcomeId,
      group: input.group
    }));
  }

  private async applyEntry(
    callerProfileId: string,
    group: string,
    request: ApiE2eeSubmitEntryRequest,
    entry: DecodedEntry,
    connection: Conn
  ): Promise<SequencedEntry> {
    const groupRow = await this.db.lockGroup(group, connection);
    if (!groupRow) throw e2eeErrors.notFound('Group');
    const epoch = Number(groupRow.epoch);
    if (request.epoch !== epoch) throw e2eeErrors.epochConflict(epoch);
    const roster = await this.db.getCurrentRoster(group, connection);
    if (!roster.some((row) => row.device_key === request.sender_device_key)) {
      throw e2eeErrors.notMember();
    }
    const isCommit = entry.kind === E2eeEntryKind.COMMIT;
    if (!isCommit) {
      await this.assertProposalAllowed(
        callerProfileId,
        group,
        epoch,
        roster,
        entry,
        connection
      );
    }
    const delta = await this.computeRosterDelta(
      callerProfileId,
      roster,
      entry.rosterAdd,
      entry.rosterRemove,
      connection
    );
    const now = this.deps.now();
    const seq = Number(groupRow.last_seq) + 1;
    const nextEpoch = isCommit ? epoch + 1 : epoch;
    await this.db.insertLogItem(
      {
        group_handle: group,
        seq,
        item_type: 'entry',
        epoch,
        kind: entry.kind,
        commit_epoch: isCommit ? epoch : null,
        data: entry.data,
        padded_len: entry.data.length,
        entry_hash: request.entry_hash,
        epoch_commitment: request.epoch_commitment,
        next_commit_key: request.next_commit_key,
        signature: request.signature,
        roster_add: JSON.stringify(entry.rosterAdd),
        roster_remove: JSON.stringify(entry.rosterRemove),
        epoch_fp: null,
        sender_device_key: request.sender_device_key,
        sender_profile_id: callerProfileId,
        created_at: now
      },
      connection
    );
    if (isCommit) {
      await this.db.insertGroupEpoch(
        {
          group,
          epoch: nextEpoch,
          commitKey: request.next_commit_key,
          createdAt: now
        },
        connection
      );
    }
    await this.db.updateGroupHead(
      {
        group,
        epoch: nextEpoch,
        commitKey: isCommit ? request.next_commit_key : groupRow.commit_key,
        lastSeq: seq,
        updatedAt: now
      },
      connection
    );
    await this.db.removeFromRoster(
      {
        group,
        deviceKeys: delta.removeKeys,
        // Proposals (leaves) too: the leaving devices keep reading epoch n,
        // including the commit that removes them, but drop out of the
        // current roster (hints, wakes, sending) at once.
        removedEpoch: epoch + 1,
        removedAt: now,
        kind: isCommit ? 'commit' : 'leave'
      },
      connection
    );
    await this.db.insertRosterRows(
      delta.addDevices.map((device) => ({
        group_handle: group,
        device_key: device.device_key,
        profile_id: device.profile_id,
        joined_epoch: nextEpoch,
        added_at: now
      })),
      connection
    );
    const profileOf = new Map<string, string>([
      ...roster.map((row) => [row.device_key, row.profile_id] as const),
      ...delta.addDevices.map(
        (device) => [device.device_key, device.profile_id] as const
      )
    ]);
    const welcomes = entry.welcome
      ? await this.storeWelcome(
          {
            group,
            joinEpoch: nextEpoch,
            welcome: entry.welcome,
            callerProfileId,
            senderDeviceKey: request.sender_device_key,
            profileOf,
            now
          },
          connection
        )
      : [];
    const after = await this.db.getCurrentRoster(group, connection);
    return {
      item: toApiE2eeLogItem(
        {
          group_handle: group,
          seq,
          item_type: 'entry',
          epoch,
          kind: entry.kind,
          commit_epoch: isCommit ? epoch : null,
          padded_len: entry.data.length,
          entry_hash: request.entry_hash,
          epoch_commitment: request.epoch_commitment,
          next_commit_key: request.next_commit_key,
          signature: request.signature,
          roster_add: JSON.stringify(entry.rosterAdd),
          roster_remove: JSON.stringify(entry.rosterRemove),
          epoch_fp: null,
          sender_device_key: request.sender_device_key,
          sender_profile_id: callerProfileId,
          created_at: now
        },
        entry.data.toString('base64')
      ),
      profilesBefore: rosterProfiles(roster),
      profilesAfter: rosterProfiles(after),
      welcomes,
      newProfiles: delta.newProfiles
    };
  }

  /** A proposal is a leave: it may only remove the proposer's own devices. */
  private async assertProposalAllowed(
    callerProfileId: string,
    group: string,
    epoch: number,
    roster: readonly E2eeRosterRow[],
    entry: DecodedEntry,
    connection: Conn
  ): Promise<void> {
    const ownDevices = new Set(
      roster
        .filter((row) => row.profile_id === callerProfileId)
        .map((row) => row.device_key)
    );
    if (entry.rosterRemove.some((key) => !ownDevices.has(key))) {
      throw e2eeErrors.forbidden(
        'A proposal can only remove devices of the proposer'
      );
    }
    if (
      (await this.db.countProposals(group, epoch, connection)) >=
      E2EE_MAX_PROPOSALS_PER_EPOCH
    ) {
      throw e2eeErrors.rateLimited();
    }
  }

  async submitEntry(
    callerProfileId: string,
    group: string,
    request: ApiE2eeSubmitEntryRequest
  ): Promise<ApiE2eeLogItem> {
    const entry = this.decodeEntry(request);
    await requireOwnActiveDevice(
      this.deps,
      callerProfileId,
      request.sender_device_key
    );
    const digest = e2eeEntryDigest({
      group,
      epoch: request.epoch,
      kind: entry.kind,
      entryHash: request.entry_hash,
      epochCommitment: request.epoch_commitment,
      nextCommitKey: request.next_commit_key,
      paddedLen: entry.data.length
    });
    await this.verifyEpochSignature(
      group,
      request.epoch,
      digest,
      request.signature,
      (current) => e2eeErrors.epochConflict(current)
    );
    // Counted only after K_n verified, so non-members cannot burn the quota.
    await enforceE2eeRateLimit(
      this.deps,
      {
        ...E2EE_RATE_LIMITS.entriesPerGroup,
        limit: e2eeEntriesPerGroupPerHour()
      },
      group
    );
    await enforceE2eeByteBudget(
      this.deps,
      E2EE_RATE_LIMITS.logBytesPerProfile,
      callerProfileId,
      entry.data.length +
        (entry.welcome?.data.length ?? 0) +
        (entry.welcome?.ratchetTree?.length ?? 0)
    );
    let sequenced: SequencedEntry;
    try {
      sequenced = await this.db.executeNativeQueriesInTransaction(
        (connection) =>
          this.applyEntry(callerProfileId, group, request, entry, connection)
      );
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
      // The unique (group, commit_epoch) and epoch-key constraints are the
      // backstop for first-commit-wins.
      const current = await this.db.getGroup(group);
      throw e2eeErrors.epochConflict(Number(current?.epoch ?? request.epoch));
    }
    await this.deps.events.groupEvent(
      [...sequenced.profilesBefore, ...sequenced.profilesAfter],
      {
        group,
        seq: sequenced.item.seq,
        epoch: sequenced.item.epoch,
        type: 'entry',
        item: sequenced.item
      }
    );
    await this.deps.events.welcomes(sequenced.welcomes);
    await this.deps.events.wake(group, sequenced.newProfiles, 'added');
    await maybePruneE2ee(this.deps);
    return sequenced.item;
  }

  // ------------------------------------------------------------ messages

  async sendMessage(
    callerProfileId: string,
    group: string,
    request: ApiE2eeSendMessageRequest
  ): Promise<ApiE2eeSendMessageResponse> {
    const data = decodeE2eeBase64(request.data, 'data', E2EE_MAX_MESSAGE_BYTES);
    if (!isE2eeBucketLength(data.length, E2EE_MESSAGE_BUCKETS)) {
      throw e2eeErrors.badRequest('data length must be a message bucket size');
    }
    await requireOwnActiveDevice(
      this.deps,
      callerProfileId,
      request.sender_device_key
    );
    await enforceE2eeRateLimit(
      this.deps,
      E2EE_RATE_LIMITS.messagesPerDevice,
      request.sender_device_key
    );
    await enforceE2eeByteBudget(
      this.deps,
      E2EE_RATE_LIMITS.logBytesPerProfile,
      callerProfileId,
      data.length
    );
    const now = this.deps.now();
    const { item, profiles } = await this.db.executeNativeQueriesInTransaction(
      async (connection) => {
        const groupRow = await this.db.lockGroup(group, connection);
        if (!groupRow) throw e2eeErrors.notMember();
        const roster = await this.db.getCurrentRoster(group, connection);
        if (
          !roster.some((row) => row.device_key === request.sender_device_key)
        ) {
          throw e2eeErrors.notMember();
        }
        const epoch = Number(groupRow.epoch);
        if (request.epoch !== epoch) throw e2eeErrors.epochStale(epoch);
        const seq = Number(groupRow.last_seq) + 1;
        const meta: E2eeLogMetaRow = {
          group_handle: group,
          seq,
          item_type: 'message',
          epoch,
          kind: null,
          commit_epoch: null,
          padded_len: data.length,
          entry_hash: null,
          epoch_commitment: null,
          next_commit_key: null,
          signature: null,
          roster_add: null,
          roster_remove: null,
          epoch_fp: request.epoch_fp,
          sender_device_key: request.sender_device_key,
          sender_profile_id: callerProfileId,
          created_at: now
        };
        await this.db.insertLogItem({ ...meta, data }, connection);
        await this.db.updateGroupHead(
          {
            group,
            epoch,
            commitKey: groupRow.commit_key,
            lastSeq: seq,
            updatedAt: now
          },
          connection
        );
        return {
          item: toApiE2eeLogItem(meta, data.toString('base64')),
          profiles: rosterProfiles(roster)
        };
      }
    );
    await this.deps.events.groupEvent(profiles, {
      group,
      seq: item.seq,
      epoch: item.epoch,
      type: 'message',
      item
    });
    const rosterSet = new Set(profiles);
    await this.deps.events.wake(
      group,
      (request.notify ?? [])
        .map((hint) => hint.profile_id)
        .filter((id) => rosterSet.has(id) && id !== callerProfileId),
      'message'
    );
    await maybePruneE2ee(this.deps);
    return { seq: item.seq, created_at: item.created_at };
  }

  // -------------------------------------------------------------- roster

  /**
   * A repair must not undo a leave at the delivery level: no device whose
   * latest row in the group ended with its profile's leave proposal, and no
   * device of a profile that left and has no device in the roster, unless
   * the requester is that profile.
   */
  private async assertRepairKeepsLeaves(
    callerProfileId: string,
    group: string,
    roster: readonly E2eeRosterRow[],
    addDevices: readonly E2eeDeviceRow[],
    connection: Conn
  ): Promise<void> {
    const candidates = addDevices.filter(
      (device) => device.profile_id !== callerProfileId
    );
    if (!candidates.length) return;
    const history = await this.db.getRosterHistory(
      group,
      candidates.map((device) => device.device_key),
      candidates.map((device) => device.profile_id),
      connection
    );
    const latestByDevice = new Map<string, E2eeRosterRow>();
    const latestByProfile = new Map<string, E2eeRosterRow>();
    for (const row of history) {
      latestByDevice.set(row.device_key, row);
      if (row.removed_epoch !== null) latestByProfile.set(row.profile_id, row);
    }
    const present = new Set(roster.map((row) => row.profile_id));
    for (const device of candidates) {
      const own = latestByDevice.get(device.device_key);
      const profileLatest = latestByProfile.get(device.profile_id);
      if (
        own?.removal_kind === 'leave' ||
        (!present.has(device.profile_id) &&
          profileLatest?.removal_kind === 'leave')
      ) {
        throw e2eeErrors.forbidden(
          `Device ${device.device_key} left this group; commit its removal instead`
        );
      }
    }
  }

  async repairRoster(
    callerProfileId: string,
    group: string,
    request: ApiE2eeRosterRepairRequest
  ): Promise<ApiE2eeGroup> {
    assertDistinct(request.device_keys, 'device_keys');
    if (!request.device_keys.includes(request.requester_device_key)) {
      throw e2eeErrors.badRequest('device_keys must include the requester');
    }
    await requireOwnActiveDevice(
      this.deps,
      callerProfileId,
      request.requester_device_key
    );
    await this.verifyEpochSignature(
      group,
      request.epoch,
      e2eeRosterDigest({
        group,
        epoch: request.epoch,
        deviceKeys: request.device_keys
      }),
      request.signature,
      (current) => e2eeErrors.epochStale(current)
    );
    await enforceE2eeRateLimit(
      this.deps,
      E2EE_RATE_LIMITS.rosterRepairsPerGroup,
      group
    );
    const now = this.deps.now();
    const result = await this.db.executeNativeQueriesInTransaction(
      async (connection) => {
        const groupRow = await this.db.lockGroup(group, connection);
        if (!groupRow) throw e2eeErrors.notFound('Group');
        const epoch = Number(groupRow.epoch);
        if (request.epoch !== epoch) throw e2eeErrors.epochStale(epoch);
        const roster = await this.db.getCurrentRoster(group, connection);
        const wanted = new Set(request.device_keys);
        const delta = await this.computeRosterDelta(
          callerProfileId,
          roster,
          request.device_keys,
          roster.map((row) => row.device_key).filter((key) => !wanted.has(key)),
          connection
        );
        await this.assertRepairKeepsLeaves(
          callerProfileId,
          group,
          roster,
          delta.addDevices,
          connection
        );
        await this.db.removeFromRoster(
          {
            group,
            deviceKeys: delta.removeKeys,
            removedEpoch: epoch,
            removedAt: now,
            kind: 'repair'
          },
          connection
        );
        await this.db.insertRosterRows(
          delta.addDevices.map((device) => ({
            group_handle: group,
            device_key: device.device_key,
            profile_id: device.profile_id,
            joined_epoch: epoch,
            added_at: now
          })),
          connection
        );
        const after = await this.db.getCurrentRoster(group, connection);
        return {
          changed: delta.removeKeys.length + delta.addDevices.length > 0,
          groupRow,
          profiles: [...rosterProfiles(roster), ...rosterProfiles(after)],
          after
        };
      }
    );
    if (result.changed) {
      await this.deps.events.rosterChanged(result.profiles, {
        group,
        epoch: request.epoch
      });
    }
    return toApiE2eeGroup(result.groupRow, result.after);
  }

  // ------------------------------------------------------------ welcomes

  async getWelcomes(
    callerProfileId: string,
    deviceKey: string
  ): Promise<ApiE2eeWelcome[]> {
    await requireOwnActiveDevice(this.deps, callerProfileId, deviceKey);
    const rows = takeWithinBudget(
      await this.db.getPendingWelcomeMeta(
        deviceKey,
        E2EE_MAX_WELCOMES_PER_PAGE
      ),
      (row) => Number(row.byte_length)
    );
    const data = await this.db.getWelcomeData(rows.map((row) => row.id));
    return rows
      .filter((row) => data.has(row.id))
      .map((row) => ({
        id: row.id,
        group: row.group_handle,
        epoch: Number(row.epoch),
        data: data.get(row.id)!.data_b64,
        ratchet_tree: data.get(row.id)!.ratchet_tree_b64,
        added_by_profile_id: row.added_by_profile_id,
        added_by_device_key: row.added_by_device_key,
        created_at: Number(row.created_at)
      }));
  }

  async ackWelcome(
    callerProfileId: string,
    deviceKey: string,
    welcomeId: string
  ): Promise<Record<string, never>> {
    await requireOwnActiveDevice(this.deps, callerProfileId, deviceKey);
    await this.db.executeNativeQueriesInTransaction((connection) =>
      this.db.deleteWelcomeDelivery(welcomeId, deviceKey, connection)
    );
    return {};
  }
}
