import { Interface, isAddress } from 'ethers';
import { getClaimsAdminWallets } from '@/api/seize-settings';
import { MEMES_CONTRACT } from '@/constants';
import { getEthereumRpcProvider } from '@/ethereum-rpc/ethereum-rpc-provider';
import {
  BadRequestException,
  CustomApiCompliantException,
  ForbiddenException
} from '@/exceptions';
import { isMemesContract } from '@/minting-claims/external-url';
import { equalIgnoreCase } from '@/strings';

const creatorAdminAbi = new Interface([
  'function isAdmin(address) view returns (bool)'
]);
const ADMIN_READ_TIMEOUT_MS = 5000;

export async function assertMintingClaimActionAccess(
  wallet: string | null,
  contract: string
): Promise<void> {
  // Never authorize through an arbitrary contract supplied in the URL.
  if (!isMemesContract(contract)) {
    throw new BadRequestException(
      'Minting claim actions are not supported for this contract'
    );
  }
  if (!wallet || !isAddress(wallet)) {
    throw new ForbiddenException(
      'Only claims admins can access minting claim actions'
    );
  }
  if (getClaimsAdminWallets().some((admin) => equalIgnoreCase(admin, wallet))) {
    return;
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  let allowed = false;
  try {
    // isAdmin includes the creator owner. Do not cache grants across requests.
    const result = await Promise.race([
      getEthereumRpcProvider(1).call({
        to: MEMES_CONTRACT,
        data: creatorAdminAbi.encodeFunctionData('isAdmin', [wallet])
      }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error('Admin read timed out')),
          ADMIN_READ_TIMEOUT_MS
        );
      })
    ]);
    allowed =
      creatorAdminAbi.decodeFunctionResult('isAdmin', result)[0] === true;
  } catch {
    throw new CustomApiCompliantException(
      503,
      'Unable to verify creator admin permission. Please try again.'
    );
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  if (!allowed) {
    throw new ForbiddenException(
      'Only claims admins can access minting claim actions'
    );
  }
}
