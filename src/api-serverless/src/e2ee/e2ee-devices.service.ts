import {
  E2eeServiceDeps,
  enforceE2eeRateLimit,
  filterByE2eeRateLimit,
  isActiveDevice,
  maybePruneE2ee,
  nowSeconds,
  requireOwnActiveDevice
} from '@/api/e2ee/e2ee-context';
import {
  toApiE2eeDevice,
  toApiEligibilityStatus
} from '@/api/e2ee/e2ee.mappers';
import { ApiE2eeClaimedKeyPackage } from '@/api/generated/models/ApiE2eeClaimedKeyPackage';
import { ApiE2eeClaimKeyPackagesRequest } from '@/api/generated/models/ApiE2eeClaimKeyPackagesRequest';
import { ApiE2eeClaimKeyPackagesResponse } from '@/api/generated/models/ApiE2eeClaimKeyPackagesResponse';
import { ApiE2eeDevice } from '@/api/generated/models/ApiE2eeDevice';
import { ApiE2eeDeviceLookupRequest } from '@/api/generated/models/ApiE2eeDeviceLookupRequest';
import { ApiE2eeDeviceLookupResponse } from '@/api/generated/models/ApiE2eeDeviceLookupResponse';
import { ApiE2eeEligibilityRequest } from '@/api/generated/models/ApiE2eeEligibilityRequest';
import { ApiE2eeEligibilityResponse } from '@/api/generated/models/ApiE2eeEligibilityResponse';
import { ApiE2eeKeyPackageStatus } from '@/api/generated/models/ApiE2eeKeyPackageStatus';
import { ApiE2eeMe } from '@/api/generated/models/ApiE2eeMe';
import { ApiE2eeRegisterDeviceRequest } from '@/api/generated/models/ApiE2eeRegisterDeviceRequest';
import { ApiE2eeRevokeDeviceRequest } from '@/api/generated/models/ApiE2eeRevokeDeviceRequest';
import { ApiE2eeUploadKeyPackagesRequest } from '@/api/generated/models/ApiE2eeUploadKeyPackagesRequest';
import {
  E2EE_DEVICE_LISTING_WINDOW_MS,
  E2EE_MAX_ACTIVE_DEVICES,
  E2EE_MAX_DEVICE_GROUPS,
  E2EE_MAX_KEY_PACKAGE_BYTES,
  E2EE_MAX_KEY_PACKAGE_LIFETIME_SECONDS,
  E2EE_MAX_ONE_TIME_KEY_PACKAGES,
  E2EE_RATE_LIMITS,
  E2EE_REVOCATION_MAX_SKEW_SECONDS
} from '@/e2ee/e2ee.constants';
import {
  E2eeClaimedKeyPackageRow,
  E2eeDeviceRow,
  E2eeKeyPackageInsert
} from '@/e2ee/e2ee.db';
import { e2eeRevokeDigest, verifyE2eeEd25519 } from '@/e2ee/e2ee-digests';
import {
  decodeE2eeBase64,
  sanitizeE2eeDeviceLabel
} from '@/e2ee/e2ee-encoding';
import { e2eeErrors } from '@/e2ee/e2ee-errors';
import { verifyE2eeDeviceGrant } from '@/e2ee/e2ee-grant';
import { decideE2eePolicy, E2eeEligibilityStatus } from '@/e2ee/e2ee-policy';

export class E2eeDevicesService {
  constructor(private readonly deps: E2eeServiceDeps) {}

  private get db() {
    return this.deps.db;
  }

  async getMe(callerProfileId: string): Promise<ApiE2eeMe> {
    const devices = await this.db.getListableDevicesOfProfile(
      callerProfileId,
      this.deps.now(),
      E2EE_DEVICE_LISTING_WINDOW_MS
    );
    const atSeconds = nowSeconds(this.deps);
    const active = devices.filter((device) =>
      isActiveDevice(device, atSeconds)
    );
    const statuses = await this.getKeyPackageStatuses(
      active.map((device) => device.device_key)
    );
    return {
      profile_id: callerProfileId,
      devices: devices.map(toApiE2eeDevice),
      key_packages: statuses,
      max_devices: E2EE_MAX_ACTIVE_DEVICES,
      attachments_enabled: this.deps.attachmentsEnabled()
    };
  }

  private async getKeyPackageStatuses(
    deviceKeys: string[]
  ): Promise<ApiE2eeKeyPackageStatus[]> {
    const rows = await this.db.getKeyPackageStatuses(
      deviceKeys,
      nowSeconds(this.deps)
    );
    const byDevice = new Map(rows.map((row) => [row.device_key, row]));
    return deviceKeys.map((deviceKey) => {
      const row = byDevice.get(deviceKey);
      return {
        device_key: deviceKey,
        one_time_available: Number(row?.one_time_available ?? 0),
        last_resort_expires_at:
          row?.last_resort_expires_at === null ||
          row?.last_resort_expires_at === undefined
            ? null
            : Number(row.last_resort_expires_at)
      };
    });
  }

  async getDevice(deviceKey: string): Promise<ApiE2eeDevice> {
    const device = await this.db.getDevice(deviceKey);
    if (!device) throw e2eeErrors.notFound('Device');
    return toApiE2eeDevice(device);
  }

  async getProfileDevices(profileId: string): Promise<ApiE2eeDevice[]> {
    const devices = await this.db.getListableDevicesOfProfile(
      profileId,
      this.deps.now(),
      E2EE_DEVICE_LISTING_WINDOW_MS
    );
    return devices.map(toApiE2eeDevice);
  }

  /** Bulk form of the device reads, for verifying a group's leaves at once. */
  async lookupDevices(
    request: ApiE2eeDeviceLookupRequest
  ): Promise<ApiE2eeDeviceLookupResponse> {
    const [byProfile, byKey] = await Promise.all([
      this.db.getListableDevicesOfProfiles(
        Array.from(new Set(request.profile_ids ?? [])),
        this.deps.now(),
        E2EE_DEVICE_LISTING_WINDOW_MS
      ),
      this.db.getDevices(Array.from(new Set(request.device_keys ?? [])))
    ]);
    const seen = new Set<string>();
    const devices = [...byProfile, ...byKey].filter((device) => {
      if (seen.has(device.device_key)) return false;
      seen.add(device.device_key);
      return true;
    });
    return { devices: devices.map(toApiE2eeDevice) };
  }

  private async verifyRegistration(
    callerProfileId: string,
    request: ApiE2eeRegisterDeviceRequest
  ) {
    const grant = { ...request.grant };
    const signature = request.wallet_signature.toLowerCase();
    const verification = await verifyE2eeDeviceGrant({
      grant,
      signature,
      nowSeconds: nowSeconds(this.deps),
      contractWalletVerifier: this.deps.contractWalletVerifier
    });
    if (!verification.ok) throw e2eeErrors.badGrant(verification.reason);
    const walletProfileId = await this.deps.resolveWalletProfileId(
      grant.wallet
    );
    if (walletProfileId !== callerProfileId) {
      throw e2eeErrors.badGrant('wallet_not_in_profile');
    }
    return { grant, signature, verification };
  }

  async registerDevice(
    callerProfileId: string,
    request: ApiE2eeRegisterDeviceRequest
  ): Promise<ApiE2eeDevice> {
    const { grant, signature, verification } = await this.verifyRegistration(
      callerProfileId,
      request
    );
    const now = this.deps.now();
    const atSeconds = nowSeconds(this.deps);
    const fields = {
      device_key: grant.device_key,
      wallet: grant.wallet,
      ciphersuite: grant.ciphersuite,
      issued_at_seconds: grant.issued_at,
      expires_at_seconds: grant.expires_at,
      origin: grant.origin,
      grant_id: verification.grantId,
      wallet_signature: signature,
      verified_via: verification.verifiedVia,
      label: sanitizeE2eeDeviceLabel(request.label),
      platform: String(request.platform),
      updated_at: now
    };
    const device = await this.db.executeNativeQueriesInTransaction(
      async (connection) => {
        await this.db.lockProfile(callerProfileId, connection);
        const existing = await this.db.lockDevice(grant.device_key, connection);
        if (
          existing &&
          (existing.profile_id !== callerProfileId ||
            existing.revoked_at !== null)
        ) {
          throw e2eeErrors.deviceExists();
        }
        const wasActive = existing
          ? isActiveDevice(existing, atSeconds)
          : false;
        if (
          !wasActive &&
          (await this.db.countActiveDevices(
            callerProfileId,
            atSeconds,
            connection
          )) >= E2EE_MAX_ACTIVE_DEVICES
        ) {
          throw e2eeErrors.deviceLimit(E2EE_MAX_ACTIVE_DEVICES);
        }
        if (existing) {
          await this.db.renewDevice(fields, connection);
        } else {
          await this.db.insertDevice(
            {
              ...fields,
              profile_id: callerProfileId,
              created_at: now,
              last_seen_at: now,
              revoked_at: null,
              revoker_device_key: null,
              revocation_signed_at_seconds: null,
              revocation_signature: null
            },
            connection
          );
        }
        return (await this.db.getDevice(grant.device_key, connection))!;
      }
    );
    const recipients = await this.db.getProfilesSharingRosters(
      { profileId: callerProfileId },
      E2EE_MAX_DEVICE_GROUPS
    );
    await this.deps.events.deviceAdded([callerProfileId, ...recipients], {
      profile_id: callerProfileId,
      device_key: device.device_key
    });
    await maybePruneE2ee(this.deps);
    return toApiE2eeDevice(device);
  }

  private async requireRevoker(
    callerProfileId: string,
    target: E2eeDeviceRow,
    revokerDeviceKey: string
  ): Promise<void> {
    if (revokerDeviceKey === target.device_key) return;
    const revoker = await this.db.getDevice(revokerDeviceKey);
    if (
      revoker?.profile_id !== callerProfileId ||
      !isActiveDevice(revoker, nowSeconds(this.deps))
    ) {
      throw e2eeErrors.notYourDevice();
    }
  }

  async revokeDevice(
    callerProfileId: string,
    deviceKey: string,
    request: ApiE2eeRevokeDeviceRequest
  ): Promise<ApiE2eeDevice> {
    const target = await this.db.getDevice(deviceKey);
    if (!target) throw e2eeErrors.notFound('Device');
    if (target.profile_id !== callerProfileId) {
      throw e2eeErrors.notYourDevice();
    }
    if (target.revoked_at !== null) return toApiE2eeDevice(target);
    if (
      Math.abs(request.revoked_at - nowSeconds(this.deps)) >
      E2EE_REVOCATION_MAX_SKEW_SECONDS
    ) {
      throw e2eeErrors.badRequest(
        'revoked_at must be within 10 minutes of the server time'
      );
    }
    await this.requireRevoker(
      callerProfileId,
      target,
      request.revoker_device_key
    );
    const digest = e2eeRevokeDigest({
      targetDeviceKey: deviceKey,
      revokerDeviceKey: request.revoker_device_key,
      revokedAtSeconds: request.revoked_at
    });
    if (
      !verifyE2eeEd25519(request.revoker_device_key, digest, request.signature)
    ) {
      throw e2eeErrors.badSignature('revocation');
    }
    const recipients = await this.db.getProfilesSharingRosters(
      { deviceKey },
      E2EE_MAX_DEVICE_GROUPS
    );
    const now = this.deps.now();
    const revoked = await this.db.executeNativeQueriesInTransaction(
      async (connection) => {
        const locked = await this.db.lockDevice(deviceKey, connection);
        if (locked?.revoked_at === null) {
          await this.db.markDeviceRevoked(
            {
              deviceKey,
              revokedAtMs: now,
              revokerDeviceKey: request.revoker_device_key,
              signedAtSeconds: request.revoked_at,
              signature: request.signature
            },
            connection
          );
          await this.db.removeDeviceFromAllRosters(deviceKey, now, connection);
          await this.db.deleteKeyPackagesOfDevice(deviceKey, connection);
          await this.db.deleteWelcomeDeliveriesOfDevice(deviceKey, connection);
        }
        return (await this.db.getDevice(deviceKey, connection))!;
      }
    );
    await this.deps.events.deviceRevoked([callerProfileId, ...recipients], {
      profile_id: callerProfileId,
      device_key: deviceKey
    });
    await maybePruneE2ee(this.deps);
    return toApiE2eeDevice(revoked);
  }

  private decodeKeyPackages(
    deviceKey: string,
    request: ApiE2eeUploadKeyPackagesRequest
  ): E2eeKeyPackageInsert[] {
    const atSeconds = nowSeconds(this.deps);
    const now = this.deps.now();
    const rows = request.key_packages.map((keyPackage, index) => {
      const data = decodeE2eeBase64(
        keyPackage.data,
        `key_packages[${index}].data`,
        E2EE_MAX_KEY_PACKAGE_BYTES
      );
      if (!data.length) {
        throw e2eeErrors.badRequest(`key_packages[${index}].data is empty`);
      }
      if (
        keyPackage.expires_at <= atSeconds ||
        keyPackage.expires_at >
          atSeconds + E2EE_MAX_KEY_PACKAGE_LIFETIME_SECONDS
      ) {
        throw e2eeErrors.badRequest(
          `key_packages[${index}].expires_at must be in the next 91 days`
        );
      }
      return {
        device_key: deviceKey,
        data,
        last_resort: !!keyPackage.last_resort,
        expires_at_seconds: keyPackage.expires_at,
        created_at: now
      };
    });
    if (rows.filter((row) => row.last_resort).length > 1) {
      throw e2eeErrors.badRequest('At most one last-resort KeyPackage');
    }
    return rows;
  }

  async uploadKeyPackages(
    callerProfileId: string,
    deviceKey: string,
    request: ApiE2eeUploadKeyPackagesRequest
  ): Promise<ApiE2eeKeyPackageStatus> {
    await requireOwnActiveDevice(this.deps, callerProfileId, deviceKey);
    const rows = this.decodeKeyPackages(deviceKey, request);
    const atSeconds = nowSeconds(this.deps);
    await this.db.executeNativeQueriesInTransaction(async (connection) => {
      const device = await this.db.lockDevice(deviceKey, connection);
      if (!device || !isActiveDevice(device, atSeconds)) {
        throw e2eeErrors.notYourDevice();
      }
      await this.db.deleteExpiredKeyPackagesOfDevice(
        deviceKey,
        atSeconds,
        connection
      );
      const existing = await this.db.countOneTimeKeyPackages(
        deviceKey,
        atSeconds,
        connection
      );
      const added = rows.filter((row) => !row.last_resort).length;
      if (existing + added > E2EE_MAX_ONE_TIME_KEY_PACKAGES) {
        throw e2eeErrors.keyPackageLimit(E2EE_MAX_ONE_TIME_KEY_PACKAGES);
      }
      if (rows.some((row) => row.last_resort)) {
        await this.db.deleteLastResortKeyPackages(deviceKey, connection);
      }
      await this.db.insertKeyPackages(rows, connection);
    });
    await maybePruneE2ee(this.deps);
    const [status] = await this.getKeyPackageStatuses([deviceKey]);
    return status;
  }

  /** Profiles sharing the group's roster with the claimer device bypass policy. */
  private async getBypassProfiles(
    group: string | undefined,
    claimerDeviceKey: string
  ): Promise<Set<string>> {
    if (!group) return new Set();
    const roster = await this.db.getCurrentRoster(group);
    if (!roster.some((row) => row.device_key === claimerDeviceKey)) {
      return new Set();
    }
    return new Set(roster.map((row) => row.profile_id));
  }

  private async evaluate(
    callerProfileId: string,
    profileIds: string[],
    bypass: Set<string>
  ) {
    const facts = await this.db.getPolicyFacts(
      callerProfileId,
      profileIds,
      nowSeconds(this.deps)
    );
    return new Map(
      profileIds.map((profileId) => {
        const profileFacts = facts.get(profileId)!;
        return [
          profileId,
          {
            status: decideE2eePolicy({
              callerProfileId,
              facts: profileFacts,
              bypass: bypass.has(profileId)
            }),
            activeDevices: profileFacts.activeDevices
          }
        ];
      })
    );
  }

  async checkEligibility(
    callerProfileId: string,
    request: ApiE2eeEligibilityRequest
  ): Promise<ApiE2eeEligibilityResponse> {
    await enforceE2eeRateLimit(
      this.deps,
      E2EE_RATE_LIMITS.eligibilityPerProfile,
      callerProfileId
    );
    const profileIds = Array.from(new Set(request.profile_ids));
    const decisions = await this.evaluate(
      callerProfileId,
      profileIds,
      new Set()
    );
    return {
      results: profileIds.map((profileId) => {
        const decision = decisions.get(profileId)!;
        return {
          profile_id: profileId,
          status: toApiEligibilityStatus(decision.status),
          active_devices: decision.activeDevices
        };
      })
    };
  }

  private async claimDevicesKeyPackages(
    devices: E2eeDeviceRow[]
  ): Promise<Map<string, E2eeClaimedKeyPackageRow>> {
    const deviceKeys = devices.map((device) => device.device_key);
    const allowed = await filterByE2eeRateLimit(
      this.deps,
      E2EE_RATE_LIMITS.claimsPerTargetDevice,
      deviceKeys
    );
    const atSeconds = nowSeconds(this.deps);
    const oneTime = await this.db.executeNativeQueriesInTransaction(
      (connection) =>
        this.db.claimOneTimeKeyPackages(
          deviceKeys.filter((key) => allowed.has(key)),
          atSeconds,
          connection
        ),
      { isolationLevel: 'READ COMMITTED' }
    );
    const lastResort = await this.db.getLastResortKeyPackages(
      deviceKeys.filter((key) => !oneTime.has(key)),
      atSeconds
    );
    oneTime.forEach((row, deviceKey) => lastResort.set(deviceKey, row));
    return lastResort;
  }

  /** Active devices per OK target, minus the claimer, filtered by device_keys. */
  private async selectClaimDevices(
    request: ApiE2eeClaimKeyPackagesRequest,
    okProfiles: Set<string>
  ): Promise<Map<string, E2eeDeviceRow[]>> {
    const activeDevices = await this.db.getActiveDevicesOfProfiles(
      Array.from(okProfiles),
      nowSeconds(this.deps)
    );
    const devicesByProfile = new Map<string, E2eeDeviceRow[]>();
    for (const target of request.targets) {
      if (!okProfiles.has(target.profile_id)) continue;
      const wanted = new Set(target.device_keys ?? []);
      devicesByProfile.set(
        target.profile_id,
        activeDevices.filter(
          (device) =>
            device.profile_id === target.profile_id &&
            device.device_key !== request.claimer_device_key &&
            (!target.device_keys || wanted.has(device.device_key))
        )
      );
    }
    return devicesByProfile;
  }

  private toClaimedKeyPackages(
    devices: E2eeDeviceRow[],
    claimed: Map<string, E2eeClaimedKeyPackageRow>
  ): ApiE2eeClaimedKeyPackage[] {
    return devices
      .filter((device) => claimed.has(device.device_key))
      .map((device) => {
        const row = claimed.get(device.device_key)!;
        return {
          device: toApiE2eeDevice(device),
          key_package: row.data_b64.replace(/\s+/g, ''),
          last_resort: !!row.last_resort
        };
      });
  }

  async claimKeyPackages(
    callerProfileId: string,
    request: ApiE2eeClaimKeyPackagesRequest
  ): Promise<ApiE2eeClaimKeyPackagesResponse> {
    await requireOwnActiveDevice(
      this.deps,
      callerProfileId,
      request.claimer_device_key
    );
    await enforceE2eeRateLimit(
      this.deps,
      E2EE_RATE_LIMITS.claimsPerProfile,
      callerProfileId
    );
    const bypass = await this.getBypassProfiles(
      request.group,
      request.claimer_device_key
    );
    const profileIds = request.targets.map((target) => target.profile_id);
    const decisions = await this.evaluate(callerProfileId, profileIds, bypass);
    const okProfiles = new Set(
      profileIds.filter(
        (id) => decisions.get(id)!.status === E2eeEligibilityStatus.OK
      )
    );
    const devicesByProfile = await this.selectClaimDevices(request, okProfiles);
    const claimed = await this.claimDevicesKeyPackages(
      Array.from(devicesByProfile.values()).flat()
    );
    return {
      results: profileIds.map((profileId) => {
        const devices = devicesByProfile.get(profileId) ?? [];
        const decided = decisions.get(profileId)!.status;
        const status =
          decided === E2eeEligibilityStatus.OK && !devices.length
            ? E2eeEligibilityStatus.NO_DEVICES
            : decided;
        return {
          profile_id: profileId,
          status: toApiEligibilityStatus(status),
          key_packages: this.toClaimedKeyPackages(devices, claimed)
        };
      })
    };
  }
}
