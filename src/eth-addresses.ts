import { WALLET_REGEX } from './constants';

export class ETHAddresses {
  public isEthAddress(candidate: string): boolean {
    return WALLET_REGEX.test(candidate);
  }
}

export const ethAddresses = new ETHAddresses();
