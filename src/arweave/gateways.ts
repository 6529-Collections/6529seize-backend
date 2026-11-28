/** Active endpoints are deliberately separate from historical input aliases. */
export const ARWEAVE_READ_GATEWAYS = [
  'ardrive.net',
  'gateway.ar.io',
  'arweave.net',
  'gateway.arweave.net'
] as const;

// These endpoints implement the native transaction/chunk and wallet APIs.
export const ARWEAVE_WRITE_GATEWAYS = ['ardrive.net', 'arweave.net'] as const;
export const ARWEAVE_INPUT_GATEWAYS = [
  ...ARWEAVE_READ_GATEWAYS,
  'ar-io.net',
  'turbo-gateway.com'
] as const;

export function arweaveContentUrl(transactionId: string): string {
  return `https://arweave.net/${transactionId}`;
}

export function isArweaveSandboxHost(host: string): boolean {
  return ARWEAVE_READ_GATEWAYS.some((gateway) => {
    const suffix = gateway === 'gateway.ar.io' ? 'ar.io' : gateway;
    const label = host.endsWith(`.${suffix}`)
      ? host.slice(0, -suffix.length - 1)
      : '';
    return /^[a-z2-7]{52}$/.test(label);
  });
}
