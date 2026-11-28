import { intentBody, mintCard } from '@/mint-log/mint-log-http';
import type { MintWriteSpec } from '@/mint-log/mint-log-recorder';
import { REMEMES_CARD_CONTRACT } from '@/mint-log/mint-log.types';

/**
 * The mint log's record of a rememe add. The wallet signature the route
 * checked is in the intent (the request body as sent), so the entry can be
 * verified again without a device record.
 */
export function rememeAddSpec(
  requestBody: { readonly address: string },
  contract: string
): MintWriteSpec {
  return {
    kind: 'rememe.add',
    card: mintCard(REMEMES_CARD_CONTRACT, 0, contract.toLowerCase()),
    actor: {
      type: 'user',
      wallet: requestBody.address.toLowerCase(),
      authority: 'wallet signature'
    },
    intent: {
      route: 'POST /rememes/add',
      params: {},
      body: intentBody(requestBody)
    },
    walletSigned: true
  };
}
