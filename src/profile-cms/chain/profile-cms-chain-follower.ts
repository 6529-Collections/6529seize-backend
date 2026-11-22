import { AppFeatures, appFeatures } from '@/app-features';
import { Logger } from '@/logging';
import { RequestContext } from '@/request.context';
import {
  archiveOwnershipProblem,
  archivePackageToEntity,
  archivePointerEventToEntity,
  legacyPackageToRow,
  ProfileCmsArchive,
  readProfileCmsArchive
} from '@/profile-cms/chain/profile-cms-archive';
import {
  ProfileCmsChainIdentity,
  ProfileCmsChainPort,
  ProfileCmsIdentityImport,
  ProfileCmsProfileChange
} from '@/profile-cms/chain/profile-cms-chain.port';
import {
  ProfileCmsChainTarget,
  profileCmsChainTransition
} from '@/profile-cms/chain/profile-cms-chain-transition';
import {
  ProfileCmsChainDb,
  profileCmsChainDb
} from '@/profile-cms/chain/profile-cms-chain.db';
import { cmsCidMatchesBytes } from '@/profile-cms/chain/profile-cms-cid';
import { pinnedEip1271Verifier } from '@/profile-cms/chain/profile-cms-eip1271-pinned';
import {
  checkProfileCmsPublication,
  isRetryablePublicationReason
} from '@/profile-cms/chain/profile-cms-publication-check';
import {
  ProfileDocCms,
  readProfileDocCms
} from '@/profile-cms/chain/profile-doc-cms';
import { ProfileCmsPackageEntity } from '@/entities/IProfileCmsPackage';
import { CmsPublishedPackageRow } from '@/api/cms/cms.db';
import { Eip1271SignatureVerifier } from '@/profile-cms/profile-cms-signing';

export interface ProfileCmsSyncResult {
  readonly applied: number;
  readonly nextHeight: number;
  readonly waiting: number;
}

export type ProfileCmsChainApplyResult =
  | {
      readonly status: 'applied';
      readonly events: number;
      readonly refused: string | null;
    }
  | { readonly status: 'skipped'; readonly reason: string }
  | {
      readonly status: 'retry';
      readonly reason: string;
      readonly attempt: number;
    };

/** Tries before a change whose document or files stay unavailable is applied as it reads. */
export const PROFILE_CMS_MAX_CHANGE_ATTEMPTS = 5;

type CmsRead =
  | { readonly ok: true; readonly cms: ProfileDocCms | null }
  | { readonly ok: false; readonly reason: string };

interface LoadedArchive {
  readonly cid: string;
  readonly archive: ProfileCmsArchive;
  readonly packages: readonly ProfileCmsPackageEntity[];
  readonly legacyPackages: readonly CmsPublishedPackageRow[];
}

/**
 * How the follower ends a change that stays unreadable: live, the last try
 * applies it as it reads; in a rebuild from empty, the rebuild fails, since
 * it can't know what the live index saw.
 */
export type ProfileCmsFollowMode = 'live' | 'rebuild';

/** A read that may pass later: a document or file not in the store yet. */
class RetryableChainReadError extends Error {
  /**
   * @param counts false for a wait that is not a failed read (the identity
   * import still running): it doesn't use up the change's tries.
   */
  constructor(
    message: string,
    readonly counts = true
  ) {
    super(message);
    // Keeps `instanceof` working when TypeScript compiles classes to ES5.
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'RetryableChainReadError';
  }
}

/**
 * Follows `Profile[p]` writes on the chain into 6529.io's profile site tables.
 * Live, `followProfileCmsChanges` catches up from the index's own cursor; a
 * rebuild from empty replays the feed from the switch height. Both run the
 * same transition, so they leave the same rows.
 *
 * A change whose document or files are not in the store yet is retried, at
 * most {@link PROFILE_CMS_MAX_CHANGE_ATTEMPTS} times; meanwhile the person's
 * later changes wait and everyone else's go on. Live, the last try applies it
 * as it reads: an unreadable document or a missing site file serves no site.
 * In `rebuild` mode the last try fails the rebuild instead.
 */
export class ProfileCmsChainFollower {
  private readonly logger = Logger.get(this.constructor.name);
  private identityImport: Promise<ProfileCmsIdentityImport | null> | null =
    null;

  constructor(
    private readonly port: ProfileCmsChainPort,
    private readonly db: ProfileCmsChainDb = profileCmsChainDb,
    private readonly safeVerifierAt: (
      timeMs: number
    ) => Eip1271SignatureVerifier = pinnedEip1271Verifier,
    private readonly mode: ProfileCmsFollowMode = 'live'
  ) {}

  /** Applies changes in order. A person whose change must wait has their later changes wait too. */
  async applyChanges(
    changes: readonly ProfileCmsProfileChange[],
    ctx: RequestContext,
    waiting: Set<string> = new Set()
  ): Promise<{
    readonly applied: number;
    readonly retryAt: ProfileCmsProfileChange | null;
  }> {
    let applied = 0;
    let retryAt: ProfileCmsProfileChange | null = null;
    for (const change of changes) {
      if (waiting.has(change.principal)) {
        continue;
      }
      const result = await this.applyChange(change, ctx);
      if (result.status === 'retry') {
        this.logger.warn(
          `Profile site change for ${change.principal} at ${change.height} waits (try ${result.attempt}): ${result.reason}`
        );
        waiting.add(change.principal);
        retryAt = retryAt ?? change;
        continue;
      }
      if (result.status === 'applied') {
        applied++;
      }
    }
    return { applied, retryAt };
  }

  /**
   * Pages through the change feed from `fromHeight` to the finalized head.
   * `nextHeight` is where to start next time: the first change that waits,
   * else one past the last change read. `waiting` counts the people whose
   * changes wait.
   */
  async syncFrom(
    fromHeight: number,
    ctx: RequestContext
  ): Promise<ProfileCmsSyncResult> {
    let height = fromHeight;
    let applied = 0;
    let firstRetry: ProfileCmsProfileChange | null = null;
    let lastHeight: number | null = null;
    const waiting = new Set<string>();
    for (;;) {
      const page = await this.port.getChanges(height);
      const result = await this.applyChanges(page.changes, ctx, waiting);
      applied += result.applied;
      firstRetry = firstRetry ?? result.retryAt;
      lastHeight = page.changes.at(-1)?.height ?? lastHeight;
      if (page.next_height === null || page.next_height <= height) {
        break;
      }
      height = page.next_height;
    }
    const afterLast = lastHeight === null ? fromHeight : lastHeight + 1;
    return {
      applied,
      nextHeight: firstRetry ? firstRetry.height : afterLast,
      waiting: waiting.size
    };
  }

  /**
   * For a rebuild: syncs again from the first waiting change until none
   * waits. In `rebuild` mode every wait uses up a try, so this ends: a change
   * still unreadable after its last try fails the rebuild.
   */
  async syncUntilSettled(
    fromHeight: number,
    ctx: RequestContext
  ): Promise<ProfileCmsSyncResult> {
    if (this.mode !== 'rebuild') {
      throw new Error('syncUntilSettled runs only in rebuild mode');
    }
    let height = fromHeight;
    let applied = 0;
    for (;;) {
      const result = await this.syncFrom(height, ctx);
      applied += result.applied;
      if (result.waiting === 0) {
        return { ...result, applied };
      }
      height = result.nextHeight;
    }
  }

  async applyChange(
    change: ProfileCmsProfileChange,
    ctx: RequestContext
  ): Promise<ProfileCmsChainApplyResult> {
    const head = await this.db.findHead(change.principal, ctx);
    if (head && head.doc_version >= change.version) {
      return { status: 'skipped', reason: 'already_applied' };
    }
    const triedBefore =
      head?.pending_version === change.version
        ? (head.pending_attempts ?? 0)
        : 0;
    const attempt = triedBefore + 1;
    // Only the live index gives up and applies a change as it reads.
    const lastTry =
      this.mode === 'live' && attempt >= PROFILE_CMS_MAX_CHANGE_ATTEMPTS;
    try {
      const identity = await this.port.getIdentityByPrincipal(
        change.principal,
        { height: change.height }
      );
      if (!identity) {
        if (!lastTry) {
          throw new RetryableChainReadError('identity_not_found');
        }
        this.logger.error(
          `Profile change of ${change.principal} at ${change.height} has no identity; skipped`
        );
        await this.db.advanceHead(
          {
            principal: change.principal,
            profile_id: head?.profile_id ?? '',
            doc_version: change.version,
            doc_cid: change.doc_cid,
            height: change.height,
            archive_cid: head?.archive_cid ?? null,
            updated_at: change.time_ms
          },
          ctx
        );
        return { status: 'skipped', reason: 'identity_not_found' };
      }
      const cms = await this.readCms(change, lastTry);
      const archive = await this.importedArchive(
        change,
        identity,
        cms,
        head?.archive_cid ?? null,
        lastTry
      );
      const target = await this.readTarget(
        cms,
        identity,
        change.time_ms,
        archive,
        lastTry,
        ctx
      );
      return await this.write(
        change,
        identity.profile_id,
        archive,
        target,
        ctx
      );
    } catch (error) {
      if (!(error instanceof RetryableChainReadError)) {
        throw error;
      }
      const attempts =
        error.counts || this.mode === 'rebuild' ? attempt : triedBefore;
      if (
        this.mode === 'rebuild' &&
        attempts >= PROFILE_CMS_MAX_CHANGE_ATTEMPTS
      ) {
        throw new Error(
          `Profile site rebuild stopped at the change of ${change.principal} at height ${change.height}: ${error.message} after ${attempts} tries`
        );
      }
      await this.db.recordPending(
        {
          principal: change.principal,
          profile_id: head?.profile_id ?? '',
          version: change.version,
          height: change.height,
          attempts,
          reason: error.message
        },
        ctx
      );
      return { status: 'retry', reason: error.message, attempt: attempts };
    }
  }

  /**
   * Only the identity import may name a history file. The chain commits the
   * import's documents through the import file's hash. An archive a person
   * names in a document of their own is ignored, whatever its version, so
   * nobody can write history rows into 6529.io's tables.
   */
  private async importedArchive(
    change: ProfileCmsProfileChange,
    identity: ProfileCmsChainIdentity,
    cms: CmsRead,
    appliedArchiveCid: string | null,
    lastTry: boolean
  ): Promise<LoadedArchive | null> {
    const archiveCid = cms.ok ? (cms.cms?.archive ?? null) : null;
    if (!archiveCid || archiveCid === appliedArchiveCid) {
      return null;
    }
    if (!(await this.isImportWrite(change, identity))) {
      this.logger.warn(
        `Profile ${identity.profile_id} names a site archive outside the import; ignored`
      );
      return null;
    }
    try {
      return await this.loadArchive(archiveCid, identity.profile_id);
    } catch (error) {
      if (error instanceof RetryableChainReadError && !lastTry) {
        throw error;
      }
      this.logger.error(
        `Profile ${identity.profile_id}: the import's site archive ${archiveCid} is not imported: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return null;
    }
  }

  /**
   * Whether the identity import wrote this change: version 1 of an imported
   * identity, marked as the import's by the gateway, or else
   *
   * - inside the import's heights before its last block: identity
   *   operations stay refused until the import completes, so only the import
   *   writes there;
   * - in its last block (`done_height`), where the import's last units run
   *   first and people's transactions after them: only the document the
   *   import's document list names for this person.
   *
   * While the import runs it can't be decided: the change waits, without
   * using up its tries.
   */
  private async isImportWrite(
    change: ProfileCmsProfileChange,
    identity: ProfileCmsChainIdentity
  ): Promise<boolean> {
    if (change.version !== 1 || !identity.imported) {
      return false;
    }
    if (change.source !== undefined) {
      return change.source === 'import';
    }
    this.identityImport ??= this.port.getIdentityImport();
    const identityImport = await this.identityImport;
    if (identityImport === null || identityImport.done_height === null) {
      throw new RetryableChainReadError('identity_import_running', false);
    }
    if (
      change.height < identityImport.start_height ||
      change.height > identityImport.done_height
    ) {
      return false;
    }
    if (change.height < identityImport.done_height) {
      return true;
    }
    return (
      change.doc_cid !== null &&
      change.doc_cid ===
        (await this.port.getImportedProfileDocCid(change.principal))
    );
  }

  private async readCms(
    change: ProfileCmsProfileChange,
    lastTry: boolean
  ): Promise<CmsRead> {
    if (!change.doc_cid) {
      return { ok: true, cms: null };
    }
    const doc = await this.port.getProfileDoc(change.doc_cid);
    if (doc.status === 'missing') {
      if (!lastTry) {
        throw new RetryableChainReadError('profile_doc_not_found');
      }
      return { ok: false, reason: 'profile_doc_unavailable' };
    }
    if (doc.status === 'malformed') {
      return { ok: false, reason: `profile_doc_malformed: ${doc.reason}` };
    }
    return readProfileDocCms(doc.fields);
  }

  private async readTarget(
    cms: CmsRead,
    identity: ProfileCmsChainIdentity,
    timeMs: number,
    archive: LoadedArchive | null,
    lastTry: boolean,
    ctx: RequestContext
  ): Promise<ProfileCmsChainTarget> {
    if (!cms.ok) {
      return { kind: 'invalid', reason: cms.reason };
    }
    const primary = cms.cms?.primary;
    if (!primary) {
      return { kind: 'none' };
    }
    const signerAccepted =
      archive?.packages.some(
        (row) =>
          row.publication_cid === primary.publication &&
          row.published_at !== null
      ) ||
      (await this.db.isPublishedPublication(
        primary.publication,
        identity.profile_id,
        ctx
      ));
    const [publicationBytes, packageBytes] = await Promise.all([
      this.port.getDocBytes(primary.publication),
      this.port.getDocBytes(primary.package)
    ]);
    const check = await checkProfileCmsPublication(
      {
        primary,
        publicationBytes,
        packageBytes,
        profileId: identity.profile_id,
        wallets: identity.wallets.map((wallet) => wallet.toLowerCase()),
        signerAccepted,
        checkedAtMs: timeMs
      },
      this.safeVerifierAt(timeMs)
    );
    if (check.ok) {
      return { kind: 'publication', checked: check.checked };
    }
    if (isRetryablePublicationReason(check.reason) && !lastTry) {
      throw new RetryableChainReadError(check.reason);
    }
    return { kind: 'invalid', reason: check.reason };
  }

  private async loadArchive(
    cid: string,
    profileId: string
  ): Promise<LoadedArchive> {
    const bytes = await this.port.getDocBytes(cid);
    if (!bytes) {
      throw new RetryableChainReadError('archive_not_found');
    }
    if (!cmsCidMatchesBytes(cid, bytes)) {
      throw new Error(`archive ${cid} does not match its CID`);
    }
    const read = readProfileCmsArchive(bytes);
    if (!read.ok) {
      throw new Error(`archive ${cid} is invalid: ${read.reason}`);
    }
    if (read.archive.profile_id !== profileId) {
      throw new Error(`archive ${cid} names another profile`);
    }
    const ownership = archiveOwnershipProblem(read.archive);
    if (ownership) {
      throw new Error(`archive ${cid}: ${ownership}`);
    }
    const packages: ProfileCmsPackageEntity[] = [];
    for (const row of read.archive.packages) {
      packages.push(
        archivePackageToEntity(row, await this.readJsonFile(row.package))
      );
    }
    const legacyPackages: CmsPublishedPackageRow[] = [];
    for (const row of read.archive.legacy.packages) {
      if (row.signature_check.verified) {
        legacyPackages.push(
          legacyPackageToRow(row, await this.readJsonFile(row.package_json))
        );
      }
    }
    return { cid, archive: read.archive, packages, legacyPackages };
  }

  private async readJsonFile(cid: string): Promise<Record<string, unknown>> {
    const bytes = await this.port.getDocBytes(cid);
    if (!bytes) {
      throw new RetryableChainReadError(`file_not_found_${cid}`);
    }
    if (!cmsCidMatchesBytes(cid, bytes)) {
      throw new Error(`file ${cid} does not match its CID`);
    }
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error(`file ${cid} is not a JSON object`);
    }
    return value as Record<string, unknown>;
  }

  private async write(
    change: ProfileCmsProfileChange,
    profileId: string,
    archive: LoadedArchive | null,
    target: ProfileCmsChainTarget,
    ctx: RequestContext
  ): Promise<ProfileCmsChainApplyResult> {
    return this.db.executeNativeQueriesInTransaction(async (connection) => {
      const txCtx: RequestContext = { ...ctx, connection };
      await this.db.lockProfile(profileId, txCtx);
      const head = await this.db.findHead(change.principal, txCtx, true);
      if (head && head.doc_version >= change.version) {
        return { status: 'skipped', reason: 'already_applied' };
      }
      if (archive) {
        await this.importArchive(archive, txCtx);
      }
      const currentPrimary = await this.db.findPrimary(profileId, txCtx);
      const targetRow =
        target.kind === 'publication'
          ? await this.db.findPackageById(
              target.checked.publication.package_db_id,
              txCtx
            )
          : null;
      const transition = profileCmsChainTransition({
        profileId,
        principal: change.principal,
        height: change.height,
        timeMs: change.time_ms,
        version: change.version,
        docCid: change.doc_cid,
        currentPrimary,
        targetRow,
        target
      });
      for (const row of transition.packages) {
        await this.db.upsertPackage(row, txCtx);
      }
      for (const event of transition.events) {
        await this.db.insertEventIfMissing(event, txCtx);
      }
      if (transition.signature) {
        await this.db.insertSignatureIfMissing(transition.signature, txCtx);
      }
      await this.db.advanceHead(
        {
          principal: change.principal,
          profile_id: profileId,
          doc_version: change.version,
          doc_cid: change.doc_cid,
          height: change.height,
          archive_cid: archive?.cid ?? head?.archive_cid ?? null,
          updated_at: change.time_ms
        },
        txCtx
      );
      if (transition.refused) {
        this.logger.warn(
          `Profile ${profileId} names a site that is not served (${transition.refused}) at height ${change.height}`
        );
      }
      return {
        status: 'applied',
        events: transition.events.length,
        refused: transition.refused
      };
    });
  }

  private async importArchive(
    archive: LoadedArchive,
    ctx: RequestContext
  ): Promise<void> {
    for (const row of archive.packages) {
      await this.db.insertPackageIfMissing(row, ctx);
    }
    for (const event of archive.archive.pointer_events) {
      await this.db.insertEventIfMissing(
        archivePointerEventToEntity(event),
        ctx
      );
    }
    for (const signature of archive.archive.publish_signatures) {
      await this.db.insertSignatureIfMissing(signature, ctx);
    }
    const servedHashes = new Set(
      archive.legacyPackages.map((legacyPackage) => legacyPackage.package_hash)
    );
    const { skipped } = await this.db.replaceLegacyForOwner(
      archive.archive.profile_id,
      archive.archive.legacy.sites.map((site) =>
        site.primary_package_hash &&
        !servedHashes.has(site.primary_package_hash)
          ? { ...site, primary_package_hash: null, primary_static_path: null }
          : site
      ),
      archive.legacyPackages,
      ctx
    );
    if (skipped > 0) {
      this.logger.error(
        `Profile ${archive.archive.profile_id}: ${skipped} legacy rows held by another profile were not imported`
      );
    }
  }
}

/**
 * The identity mirror's hook, called after each finalized page it reads.
 * With FEATURE_PROFILE_CMS_CHAIN_POINTER off it does nothing. On, it catches
 * up from the index's own cursor (the lowest waiting change, else one past
 * the last applied), so turning the flag off and on again loses nothing.
 * The first time, it starts at PROFILE_CMS_CHAIN_FROM_HEIGHT (default 0).
 */
export async function followProfileCmsChanges(
  port: ProfileCmsChainPort,
  ctx: RequestContext,
  deps: {
    readonly features?: Pick<AppFeatures, 'isProfileCmsChainPointerEnabled'>;
    readonly db?: ProfileCmsChainDb;
    readonly follower?: ProfileCmsChainFollower;
  } = {}
): Promise<ProfileCmsSyncResult | null> {
  if (!(deps.features ?? appFeatures).isProfileCmsChainPointerEnabled()) {
    return null;
  }
  const db = deps.db ?? profileCmsChainDb;
  const fromHeight = Number(process.env.PROFILE_CMS_CHAIN_FROM_HEIGHT ?? '0');
  const cursor = await db.cursorHeight(
    Number.isSafeInteger(fromHeight) && fromHeight > 0 ? fromHeight : 0,
    ctx
  );
  return (deps.follower ?? new ProfileCmsChainFollower(port, db)).syncFrom(
    cursor,
    ctx
  );
}
