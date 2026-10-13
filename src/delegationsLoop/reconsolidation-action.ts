import { isAddress, ZeroAddress } from 'ethers';

const MAX_REQUESTED_WALLETS = 100;

/** Scheduled events have no action. Explicit maintenance requests fail closed. */
export function readReconsolidationAction(event: unknown): string[] | null {
  if (event === undefined || event === null) {
    return null;
  }
  if (typeof event !== 'object' || Array.isArray(event)) {
    throw new Error('Delegations invocation must be an object');
  }
  const request = event as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(request, 'action')) {
    if (
      Object.prototype.hasOwnProperty.call(request, 'wallets') ||
      Object.prototype.hasOwnProperty.call(request, 'reconsolidation_wallets')
    ) {
      throw new Error(
        'Wallet maintenance requests require action=reconsolidate'
      );
    }
    return null;
  }
  if (request.action !== 'reconsolidate') {
    throw new Error('Unsupported delegations action');
  }
  if (
    !Array.isArray(request.wallets) ||
    request.wallets.length === 0 ||
    request.wallets.length > MAX_REQUESTED_WALLETS
  ) {
    throw new Error('Reconsolidation requires 1 to 100 wallet addresses');
  }
  const wallets: string[] = [];
  for (const wallet of request.wallets) {
    if (
      typeof wallet !== 'string' ||
      !isAddress(wallet) ||
      wallet.toLowerCase() === ZeroAddress
    ) {
      throw new Error(
        'Reconsolidation requires valid nonzero Ethereum addresses'
      );
    }
    wallets.push(wallet.toLowerCase());
  }
  return Array.from(new Set(wallets));
}
