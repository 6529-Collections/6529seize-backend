import * as Joi from 'joi';
import { isAddress } from 'ethers';
import { RecoverDropForgeLaunchRequest } from '@/api/generated/routes/operations';
import { ApiDropForgeLaunch } from '@/api/generated/models/ApiDropForgeLaunch';
import { ApiDropForgeRecoveryRequest } from '@/api/generated/models/ApiDropForgeRecoveryRequest';
import { getAuthenticatedWalletOrNull } from '@/api/auth/auth';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import {
  getDropForgeConfig,
  recoveryEnabled,
  automationEnabled
} from '@/drop-forge/drop-forge.config';
import { assertLaunchAccess, mapLaunch } from '@/drop-forge/drop-forge.service';
import { DropForgeRecovery } from '@/drop-forge/drop-forge.recovery';
import { EthereumLaunchChain } from '@/drop-forge/drop-forge.chain';
import {
  dropForgeRepository,
  launchId
} from '@/drop-forge/drop-forge.repository';
import {
  LaunchRevisionConflict,
  LaunchSafetyError
} from '@/drop-forge/drop-forge.types';
import { BadRequestException, CustomApiCompliantException } from '@/exceptions';
import { Timer } from '@/time';
export async function recoverDropForgeLaunch(
  req: RecoverDropForgeLaunchRequest
): Promise<ApiDropForgeLaunch> {
  try {
    const { contract, claim_id } = getValidatedByJoiOrThrow(
      req.params,
      Joi.object<{ contract: string; claim_id: number }>({
        contract: Joi.string()
          .lowercase()
          .custom((value, helpers) =>
            isAddress(value) ? value : helpers.error('any.invalid')
          )
          .required(),
        claim_id: Joi.number().integer().min(1).max(0x7fffffff).required()
      })
    );
    const body = getValidatedByJoiOrThrow(
      req.body,
      Joi.object<ApiDropForgeRecoveryRequest>({
        transaction_hash: Joi.string()
          .pattern(/^0x[\da-fA-F]{64}$/)
          .when('operation', {
            is: 'RECORD_WINNER',
            then: Joi.required(),
            otherwise: Joi.forbidden()
          }),
        revision: Joi.number().integer().min(1).required(),
        request_id: Joi.string().guid().required(),
        action_id: Joi.string().min(1).max(100).required(),
        expected_hash: Joi.string()
          .pattern(/^0x[\da-fA-F]{64}$/)
          .required(),
        operation: Joi.string()
          .valid(
            'SPEED_UP',
            'CANCEL',
            'RETRY',
            'DELIVER_REMAINING',
            'RECORD_WINNER'
          )
          .required()
      })
    );
    if (!recoveryEnabled())
      throw new LaunchSafetyError(
        'Drop Forge transaction recovery is disabled'
      );
    if (
      ['RETRY', 'DELIVER_REMAINING'].includes(body.operation) &&
      !automationEnabled()
    )
      throw new LaunchSafetyError(
        'Enable scheduled execution before authorizing fresh-nonce delivery'
      );
    const wallet = getAuthenticatedWalletOrNull(req);
    await assertLaunchAccess(wallet, contract);
    const config = getDropForgeConfig();
    const record = await new DropForgeRecovery(
      config,
      dropForgeRepository,
      new EthereumLaunchChain(config)
    ).request(launchId(config.chainId, contract, claim_id), wallet!, body, {
      timer: Timer.getFromRequest(req)
    });
    return mapLaunch(record);
  } catch (error) {
    if (error instanceof LaunchRevisionConflict)
      throw new CustomApiCompliantException(409, error.message);
    if (error instanceof LaunchSafetyError)
      throw new BadRequestException(error.message);
    throw error;
  }
}
