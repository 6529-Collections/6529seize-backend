import { rpcWithDeadline } from '@/drop-forge/drop-forge.chain';
import { Request } from 'express';
import * as Joi from 'joi';
import { getAuthenticatedWalletOrNull } from '@/api/auth/auth';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import {
  automationEnabled,
  getDropForgeConfig
} from '@/drop-forge/drop-forge.config';
import { forgeSettingsAccess } from '@/drop-forge/drop-forge.access';
import {
  readForgeSettings,
  updateForgeSettings
} from '@/drop-forge/drop-forge.settings';
import { registerForgeFunding } from '@/drop-forge/drop-forge.funding';
import { getEthereumRpcProvider } from '@/ethereum-rpc/ethereum-rpc-provider';
import {
  LaunchSafetyError,
  LaunchRevisionConflict
} from '@/drop-forge/drop-forge.types';
import {
  BadRequestException,
  CustomApiCompliantException,
  ForbiddenException
} from '@/exceptions';
import { ApiDropForgeFundingResponse } from '@/api/generated/models/ApiDropForgeFundingResponse';
import { ApiDropForgeSettings } from '@/api/generated/models/ApiDropForgeSettings';

async function settingsCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof LaunchRevisionConflict)
      throw new CustomApiCompliantException(409, error.message);
    if (error instanceof LaunchSafetyError)
      throw new BadRequestException(error.message);
    throw error;
  }
}

export async function getDropForgeSettings(
  req: Request
): Promise<ApiDropForgeSettings> {
  return settingsCall(async () => {
    const config = getDropForgeConfig();
    const [access, settings, balance, ens] = await Promise.all([
      forgeSettingsAccess(config, getAuthenticatedWalletOrNull(req)),
      readForgeSettings(config),
      rpcWithDeadline(
        getEthereumRpcProvider(config.chainId).getBalance(config.signer)
      ).catch(() => null),
      resolveSignerEns(config.signer)
    ]);
    return {
      revision: settings.revision,
      automation_enabled: settings.automation_enabled,
      pay_artist_enabled: settings.pay_artist_enabled,
      updated_by: settings.updated_by,
      updated_at: settings.updated_at,
      ...access,
      chain_id: config.chainId,
      contract: config.creator,
      signer_address: config.signer,
      ens_name: ens,
      balance_wei: typeof balance === 'bigint' ? balance.toString() : null,
      execution_available: automationEnabled(),
      artist_payment_available:
        !!config.maxArtistPayment && config.maxArtistPayment > BigInt(0)
    };
  });
}

export async function putDropForgeSettings(
  req: Request
): Promise<ApiDropForgeSettings> {
  return settingsCall(async () => {
    const config = getDropForgeConfig();
    const wallet = getAuthenticatedWalletOrNull(req);
    const access = await forgeSettingsAccess(config, wallet);
    if (!access.can_edit)
      throw new ForbiddenException(
        'Only the creator owner or configured claims administrators may change launch settings'
      );
    const input = getValidatedByJoiOrThrow(
      req.body,
      Joi.object<{
        revision: number;
        automation_enabled: boolean;
        pay_artist_enabled: boolean;
      }>({
        revision: Joi.number().integer().min(0).required(),
        automation_enabled: Joi.boolean().strict().required(),
        pay_artist_enabled: Joi.boolean().strict().required()
      })
    );
    if (input.automation_enabled && !automationEnabled())
      throw new LaunchSafetyError(
        'Launch execution is not enabled for this environment'
      );
    await updateForgeSettings(config, wallet!, input);
    return getDropForgeSettings(req);
  });
}

export async function postDropForgeFunding(
  req: Request
): Promise<ApiDropForgeFundingResponse> {
  return settingsCall(async () => {
    const config = getDropForgeConfig();
    const wallet = getAuthenticatedWalletOrNull(req);
    await forgeSettingsAccess(config, wallet);
    const input = getValidatedByJoiOrThrow(
      req.body,
      Joi.object<{ hash: string }>({
        hash: Joi.string()
          .pattern(/^0x[\da-fA-F]{64}$/)
          .required()
      })
    );
    await registerForgeFunding(config, wallet!, input.hash);
    return { accepted: true };
  });
}

async function resolveSignerEns(signer: string): Promise<string | null> {
  try {
    const provider = getEthereumRpcProvider(1);
    const name = await rpcWithDeadline(provider.lookupAddress(signer));
    if (
      name &&
      (await rpcWithDeadline(provider.resolveName(name)))?.toLowerCase() ===
        signer.toLowerCase()
    )
      return name;
  } catch {
    // ENS display is optional; the configured address remains authoritative.
  }
  return null;
}
