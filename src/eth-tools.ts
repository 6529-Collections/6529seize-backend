import { NULL_ADDRESS, NULL_ADDRESS_DEAD, WALLET_REGEX } from '@/constants';
import { equalIgnoreCase } from './strings';
import { goerli, sepolia } from '@wagmi/chains';

export class EthTools {
  public isEthAddress(candidate: string): boolean {
    return WALLET_REGEX.test(candidate);
  }

  public isNullOrDeadAddress(candidate: string): boolean {
    return (
      equalIgnoreCase(candidate, NULL_ADDRESS) ||
      equalIgnoreCase(candidate, NULL_ADDRESS_DEAD)
    );
  }

  public toEtherScanTransactionLink(chain_id: number, hash: string) {
    switch (chain_id) {
      case sepolia.id:
        return `https://sepolia.etherscan.io/tx/${hash}`;
      case goerli.id:
        return `https://goerli.etherscan.io/tx/${hash}`;
      default:
        return `https://etherscan.io/tx/${hash}`;
    }
  }

  public weiToEth(wei: number): number {
    return wei / 1e18;
  }
}

export const ethTools = new EthTools();
