import { NULL_ADDRESS, NULL_ADDRESS_DEAD, WALLET_REGEX } from './constants';
import { equalIgnoreCase } from './strings';

export class ETHAddresses {
  public isEthAddress(candidate: string): boolean {
    return WALLET_REGEX.test(candidate);
  }

  public isNullOrDead(candidate: string): boolean {
    return (
      equalIgnoreCase(candidate, NULL_ADDRESS) ||
      equalIgnoreCase(candidate, NULL_ADDRESS_DEAD)
    );
  }
}

export const ethAddresses = new ETHAddresses();
