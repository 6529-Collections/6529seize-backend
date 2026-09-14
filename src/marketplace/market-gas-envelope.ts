import {
  MarketGasEstimate,
  MarketTransaction,
  MarketValidationError
} from '@/marketplace/provider.types';

/** Reuse limits only for the same transaction authority. Fulfillment authorization bytes may refresh. */
export function reviewedMarketGas(
  transaction: MarketTransaction,
  previous: MarketTransaction | undefined,
  gas = previous?.gas
): MarketGasEstimate | undefined {
  if (
    !previous ||
    transaction.chainId !== previous.chainId ||
    transaction.from.toLowerCase() !== previous.from.toLowerCase() ||
    transaction.to.toLowerCase() !== previous.to.toLowerCase() ||
    transaction.value !== previous.value ||
    transaction.purpose !== previous.purpose ||
    transaction.approvalScope !== previous.approvalScope ||
    (transaction.purpose !== 'FULFILL' &&
      transaction.data.toLowerCase() !== previous.data.toLowerCase())
  )
    return undefined;
  return gas;
}

/** These are authorization ceilings, not a fresh padded recommendation. */
export function marketGasFitsEnvelope(
  requiredGas: bigint,
  requiredFee: bigint,
  envelope: MarketGasEstimate
): boolean {
  const caps = [
    envelope.gas_limit,
    envelope.max_fee_per_gas,
    envelope.gas_reserve_wei
  ];
  if (
    caps.some(
      (value) => typeof value !== 'string' || !/^[1-9]\d{0,77}$/.test(value)
    ) ||
    BigInt(envelope.gas_limit) * BigInt(envelope.max_fee_per_gas) >
      BigInt(envelope.gas_reserve_wei)
  )
    throw new MarketValidationError(
      'ORDER_MISMATCH',
      'The reviewed network fee limits could not be verified.'
    );
  return (
    requiredGas > BigInt(0) &&
    requiredFee >= BigInt(0) &&
    requiredGas <= BigInt(envelope.gas_limit) &&
    requiredFee <= BigInt(envelope.max_fee_per_gas)
  );
}

export function sameMarketGas(
  first: MarketGasEstimate,
  second: MarketGasEstimate
): boolean {
  return (
    first.gas_limit === second.gas_limit &&
    first.max_fee_per_gas === second.max_fee_per_gas &&
    first.gas_reserve_wei === second.gas_reserve_wei
  );
}
