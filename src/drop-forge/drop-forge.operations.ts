import { randomUUID, createHash } from 'node:crypto';
import {
  automationEnabled,
  recoveryEnabled,
  getDropForgeConfig
} from '@/drop-forge/drop-forge.config';
import {
  dropForgeRepository,
  launchId,
  addLaunchEvent
} from '@/drop-forge/drop-forge.repository';
import {
  buildLaunchPlan,
  hashLaunchDistribution,
  sourceMatchesLaunch
} from '@/drop-forge/drop-forge.plan';
import { standardLaunchPlan } from '@/drop-forge/drop-forge.schedule';
import { assertProcessComplete } from '@/drop-forge/drop-forge.workflow';
import { EthereumLaunchChain } from '@/drop-forge/drop-forge.chain';
import { dropForgePreparationRepository } from '@/drop-forge/drop-forge.preparation.repository';
import { validateForgeReporting } from '@/drop-forge/drop-forge.reporting-access';
import {
  evidenceForClaim,
  storeEvidence
} from '@/drop-forge/drop-forge.evidence';
import { LaunchRecord, LaunchSafetyError } from '@/drop-forge/drop-forge.types';
import { RequestContext } from '@/request.context';

export async function readyLaunch(
  claim: number,
  ctx: RequestContext
): Promise<LaunchRecord> {
  if (!automationEnabled())
    throw new LaunchSafetyError('Automatic launch execution is disabled');
  const config = getDropForgeConfig();
  const id = launchId(config.chainId, config.creator, claim);
  const existing = await dropForgeRepository.find(id, ctx);
  if (existing && existing.state !== 'DRAFT') return existing;
  const source = await dropForgeRepository.source(config.creator, claim, ctx);
  if (!source.metadata)
    throw new LaunchSafetyError('Publish Craft changes before launching');
  const chain = new EthereumLaunchChain(config);
  const now = await chain.now();
  const input = await standardLaunchPlan(claim, source, now);
  const data = buildLaunchPlan(config, claim, input, source, now, true);
  data.managed = true;
  data.distribution_hash = hashLaunchDistribution(source);
  await validateForgeReporting(config, ctx);
  const result = await dropForgePreparationRepository.run(
    config.creator,
    claim,
    async (_, txCtx) => {
      // The preparation lock serializes duplicate Ready clicks with publication.
      const current = await dropForgeRepository.find(id, txCtx);
      if (current && current.state !== 'DRAFT') return current;
      if (
        !sourceMatchesLaunch(
          await dropForgeRepository.source(config.creator, claim, txCtx),
          data
        )
      )
        throw new LaunchSafetyError(
          'Distribution changed while preparing launch; retry'
        );
      await assertProcessComplete(config.creator, claim, txCtx);
      await dropForgeRepository.assertPrepared(data, txCtx);
      data.manual_transactions = (
        await evidenceForClaim(config, claim, txCtx)
      ).map((proof) => ({ ...proof, state: 'PENDING' as const }));
      const saved: LaunchRecord = {
        id,
        revision: current?.revision ?? 0,
        state: 'ARMED',
        error: null,
        data,
        updated_at: Date.now()
      };
      addLaunchEvent(
        saved,
        `Claim #${claim}: Launch requested; initialization queued.`
      );
      await dropForgeRepository.save(saved, txCtx, true);
      return saved;
    },
    ctx,
    false,
    true
  );
  return result;
}
export async function requestMetadataUpdate(
  claim: number,
  ctx: RequestContext
): Promise<LaunchRecord> {
  if (!automationEnabled())
    throw new LaunchSafetyError('Automatic launch execution is disabled');
  const config = getDropForgeConfig();
  const id = launchId(config.chainId, config.creator, claim);
  const source = await dropForgeRepository.source(config.creator, claim, ctx);
  if (!source.metadata)
    throw new LaunchSafetyError('Publish updated Craft metadata first');
  const now = await new EthereumLaunchChain(config).now();
  await dropForgeRepository.change(
    id,
    (record) => {
      if (
        !record.data.managed ||
        record.state === 'CANCELLED' ||
        record.data.manual_lease
      )
        throw new LaunchSafetyError(
          'This launch cannot accept an automatic metadata update'
        );
      if (!sourceMatchesLaunch(source, record.data))
        throw new LaunchSafetyError(
          'Edition or distribution changed; metadata update cannot change launch allocations'
        );
      if (
        record.data.actions.some(
          (it) =>
            it.kind === 'METADATA' &&
            ['RESERVED', 'SIGNED'].includes(it.state) &&
            it.target_metadata !== source.metadata
        )
      ) {
        throw new LaunchSafetyError(
          'A metadata transaction is in flight; wait for its reconciliation before requesting a newer publication'
        );
      }
      const superseded = record.data.actions.filter(
        (it) =>
          it.kind === 'METADATA' &&
          it.state === 'PENDING' &&
          it.target_metadata !== source.metadata
      );
      if (superseded.length) {
        record.data.actions = record.data.actions.filter(
          (it) => !superseded.includes(it)
        );
        if (
          record.state === 'BLOCKED' &&
          [
            'A newer Craft publication exists; request its metadata update',
            'Craft publication changed before metadata signing'
          ].includes(record.error ?? '')
        ) {
          record.state = 'RUNNING';
          record.error = null;
        }
        addLaunchEvent(
          record,
          `Claim #${claim}: Unsubmitted metadata request superseded by the current publication.`
        );
      }
      const actionId = `metadata-${createHash('sha256').update(source.metadata).digest('hex').slice(0, 24)}`;
      if (
        record.data.metadata === source.metadata ||
        record.data.actions.some(
          (it) =>
            it.target_metadata === source.metadata && it.state !== 'CONFIRMED'
        )
      )
        return;
      const next = record.data.actions.findIndex(
        (it) => it.state !== 'CONFIRMED' && it.due > now + 600
      );
      const phase =
        [...record.data.actions]
          .reverse()
          .find(
            (it) =>
              it.kind !== 'AIRDROP' &&
              it.kind !== 'METADATA' &&
              it.state === 'CONFIRMED'
          )?.phase ?? 0;
      const action = {
        id: `${actionId}-${record.revision}`,
        label: 'Metadata update',
        kind: 'METADATA' as const,
        phase,
        due: now,
        deadline: now + 86400,
        recipients: [],
        state: 'PENDING' as const,
        target_metadata: source.metadata
      };
      if (next < 0) record.data.actions.push(action);
      else record.data.actions.splice(next, 0, action);
      if (record.state === 'COMPLETED') record.state = 'RUNNING';
      addLaunchEvent(
        record,
        `Claim #${claim}: Published metadata update queued.`
      );
    },
    ctx,
    true
  );
  return (await dropForgeRepository.find(id, ctx))!;
}
export async function coordinateManual(
  claim: number,
  wallet: string,
  operation: string,
  lease: string | undefined,
  hash: string | undefined,
  actionHint: string | undefined,
  ctx: RequestContext
): Promise<string | null> {
  // Existing manual operations remain usable before automation is configured.
  if (!recoveryEnabled()) return null;
  const config = getDropForgeConfig();
  const chain = new EthereumLaunchChain(config);
  const id = launchId(config.chainId, config.creator, claim);
  if (operation === 'SUBMIT') {
    if (!hash) throw new LaunchSafetyError('Transaction hash is required');
    await chain.inspectTransaction(config.creator, claim, hash, wallet);
    const held = (await dropForgeRepository.find(id, ctx))?.data.manual_lease;
    await storeEvidence(config, claim, hash, held?.action ?? actionHint, ctx);
  }
  let leaseId: string | null = null;
  await dropForgeRepository.wallet(
    `${config.chainId}:${config.signer.toLowerCase()}`,
    async (pending, txCtx) => {
      const found = await dropForgeRepository.find(id, txCtx);
      if (!found) return;
      await dropForgeRepository.change(
        id,
        async (record) => {
          if (operation === 'BEGIN') {
            if (pending.launch_id === id || record.data.manual_lease)
              throw new LaunchSafetyError(
                'A transaction is already in flight; wait for reconciliation before manual work'
              );
            leaseId = randomUUID();
            record.data.manual_lease = {
              id: leaseId,
              wallet,
              action: actionHint,
              previous_state: record.state,
              nonce: await chain.nonce(wallet, true)
            };
            record.state = 'PAUSED';
            addLaunchEvent(
              record,
              `Claim #${claim}: Automatic execution paused for a manual transaction.`
            );
            return;
          }
          const held = record.data.manual_lease;
          if (
            held &&
            ((lease !== undefined && held.id !== lease) ||
              held.wallet.toLowerCase() !== wallet.toLowerCase())
          )
            throw new LaunchSafetyError('Manual operation ownership changed');
          if (operation === 'CANCEL' && held) {
            const [latest, pendingNonce] = await Promise.all([
              chain.nonce(wallet, false),
              chain.nonce(wallet, true)
            ]);
            if (latest !== held.nonce || pendingNonce !== held.nonce)
              throw new LaunchSafetyError(
                'Manual transaction outcome is uncertain; register its hash before resuming'
              );
          }
          if (operation === 'SUBMIT' && hash)
            registerManualTransaction(record, hash, actionHint);
          if (held) {
            record.state =
              held.previous_state === 'COMPLETED'
                ? 'RUNNING'
                : held.previous_state;
            delete record.data.manual_lease;
          }
          addLaunchEvent(
            record,
            `Claim #${claim}: ${hash ? 'Manual transaction registered: ' + hash : 'Manual operation cancelled.'}`
          );
        },
        txCtx,
        true
      );
    },
    ctx
  );
  return leaseId;
}

function registerManualTransaction(
  record: LaunchRecord,
  hash: string,
  actionHint: string | undefined
): void {
  const held = record.data.manual_lease;
  record.data.manual_transactions ??= [];
  const existing = record.data.manual_transactions.find(
    (it) => it.hash.toLowerCase() === hash.toLowerCase()
  );
  if (existing?.state === 'PENDING' && !existing.action && actionHint)
    existing.action = actionHint;
  if (
    !record.data.manual_transactions.some(
      (it) => it.hash.toLowerCase() === hash.toLowerCase()
    )
  )
    record.data.manual_transactions.push({
      hash,
      state: 'PENDING',
      action: held?.action ?? actionHint
    });
}
