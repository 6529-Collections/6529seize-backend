import { ApiWalletDistributionAllocations } from '@/api/generated/models/ApiWalletDistributionAllocations';
import { GetWalletDistributionAllocationsRequest } from '@/api/generated/routes/operations';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import { Timer } from '@/time';
import { ethers } from 'ethers';
import * as Joi from 'joi';
import { getWalletDistributionAllocations } from './get-wallet-distribution-allocations.service';

function normalizeEthereumAddress(value: string, helpers: Joi.CustomHelpers) {
  return ethers.isAddress(value)
    ? value.toLowerCase()
    : helpers.error('any.invalid');
}

const PathSchema = Joi.object({
  contract: Joi.string().trim().custom(normalizeEthereumAddress).required(),
  card_id: Joi.number().integer().min(1).required()
});

const QuerySchema = Joi.object({
  wallet: Joi.string().trim().custom(normalizeEthereumAddress).required()
});

export async function handleGetWalletDistributionAllocations(
  req: GetWalletDistributionAllocationsRequest
): Promise<ApiWalletDistributionAllocations> {
  const { contract, card_id: cardId } = getValidatedByJoiOrThrow(
    req.params,
    PathSchema
  );
  const { wallet } = getValidatedByJoiOrThrow(req.query, QuerySchema);

  return getWalletDistributionAllocations(contract, cardId, wallet, {
    timer: Timer.getFromRequest(req)
  });
}
