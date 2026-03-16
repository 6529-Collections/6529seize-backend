import {
  getBestEffortArtCurationTransferPrice,
  type ArtCurationTransferPricingReceipt
} from '@/art-curation/art-curation-token-watch-price';
import { SEAPORT_IFACE } from '@/abis/seaport';
import { ethers } from 'ethers';

const ERC721_TRANSFER_IFACE = new ethers.Interface([
  'event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)'
]);
const ERC20_TRANSFER_IFACE = new ethers.Interface([
  'event Transfer(address indexed from,address indexed to,uint256 value)'
]);

describe('getBestEffortArtCurationTransferPrice', () => {
  const nftContract = '0x1111111111111111111111111111111111111111';
  const weth = '0x2222222222222222222222222222222222222222';
  const conduit = '0x3333333333333333333333333333333333333333';
  const seller = '0x4444444444444444444444444444444444444444';
  const buyer = '0x5555555555555555555555555555555555555555';

  it('attributes Seaport value even when the transfer includes an operator hop', () => {
    const price = getBestEffortArtCurationTransferPrice({
      transaction: {
        from: buyer,
        value: BigInt(0)
      },
      receipt: {
        logs: [
          makeErc721Transfer({
            contract: nftContract,
            from: seller,
            to: conduit,
            tokenId: BigInt(1)
          }),
          makeErc721Transfer({
            contract: nftContract,
            from: conduit,
            to: buyer,
            tokenId: BigInt(1)
          }),
          makeOrderFulfilledLog({
            orderHash:
              '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            offerer: seller,
            recipient: buyer,
            offer: [
              {
                itemType: 2,
                token: nftContract,
                identifier: BigInt(1),
                amount: BigInt(1)
              }
            ],
            consideration: [
              {
                itemType: 1,
                token: weth,
                identifier: BigInt(0),
                amount: ethers.parseEther('2'),
                recipient: seller
              }
            ]
          })
        ]
      },
      contract: nftContract,
      tokenId: '1'
    });

    expect(price).toEqual({
      amountRaw: ethers.parseEther('2').toString(),
      currency: weth.toLowerCase()
    });
  });

  it('falls back to native transaction value for a direct paid transfer', () => {
    const price = getBestEffortArtCurationTransferPrice({
      transaction: {
        from: buyer,
        value: ethers.parseEther('1.5')
      },
      receipt: {
        logs: [
          makeErc721Transfer({
            contract: nftContract,
            from: seller,
            to: buyer,
            tokenId: BigInt(1)
          })
        ]
      },
      contract: nftContract,
      tokenId: '1'
    });

    expect(price).toEqual({
      amountRaw: ethers.parseEther('1.5').toString(),
      currency: ethers.ZeroAddress.toLowerCase()
    });
  });

  it('falls back to ERC20 buyer outflow for a direct token-funded transfer', () => {
    const price = getBestEffortArtCurationTransferPrice({
      transaction: {
        from: buyer,
        value: BigInt(0)
      },
      receipt: {
        logs: [
          makeErc721Transfer({
            contract: nftContract,
            from: seller,
            to: buyer,
            tokenId: BigInt(1)
          }),
          makeErc20Transfer({
            token: weth,
            from: buyer,
            to: seller,
            amount: ethers.parseEther('3')
          })
        ]
      },
      contract: nftContract,
      tokenId: '1'
    });

    expect(price).toEqual({
      amountRaw: ethers.parseEther('3').toString(),
      currency: weth.toLowerCase()
    });
  });

  it('returns null when the transaction transfers multiple different NFTs without exact attribution', () => {
    const price = getBestEffortArtCurationTransferPrice({
      transaction: {
        from: buyer,
        value: ethers.parseEther('5')
      },
      receipt: {
        logs: [
          makeErc721Transfer({
            contract: nftContract,
            from: seller,
            to: buyer,
            tokenId: BigInt(1)
          }),
          makeErc721Transfer({
            contract: nftContract,
            from: seller,
            to: buyer,
            tokenId: BigInt(2)
          })
        ]
      },
      contract: nftContract,
      tokenId: '1'
    });

    expect(price).toEqual({
      amountRaw: null,
      currency: null
    });
  });
});

function makeErc721Transfer({
  contract,
  from,
  to,
  tokenId
}: {
  contract: string;
  from: string;
  to: string;
  tokenId: bigint;
}): ArtCurationTransferPricingReceipt['logs'][number] {
  const event = ERC721_TRANSFER_IFACE.encodeEventLog(
    ERC721_TRANSFER_IFACE.getEvent('Transfer')!,
    [from, to, tokenId]
  );
  return {
    address: contract,
    topics: event.topics,
    data: event.data
  };
}

function makeErc20Transfer({
  token,
  from,
  to,
  amount
}: {
  token: string;
  from: string;
  to: string;
  amount: bigint;
}): ArtCurationTransferPricingReceipt['logs'][number] {
  const event = ERC20_TRANSFER_IFACE.encodeEventLog(
    ERC20_TRANSFER_IFACE.getEvent('Transfer')!,
    [from, to, amount]
  );
  return {
    address: token,
    topics: event.topics,
    data: event.data
  };
}

function makeOrderFulfilledLog({
  orderHash,
  offerer,
  recipient,
  offer,
  consideration
}: {
  orderHash: string;
  offerer: string;
  recipient: string;
  offer: Array<{
    itemType: number;
    token: string;
    identifier: bigint;
    amount: bigint;
  }>;
  consideration: Array<{
    itemType: number;
    token: string;
    identifier: bigint;
    amount: bigint;
    recipient: string;
  }>;
}): ArtCurationTransferPricingReceipt['logs'][number] {
  const event = SEAPORT_IFACE.encodeEventLog(
    SEAPORT_IFACE.getEvent('OrderFulfilled')!,
    [orderHash, offerer, ethers.ZeroAddress, recipient, offer, consideration]
  );

  return {
    address: '0x00000000000000adc04c56bf30ac9d3c0aaf14dc',
    topics: event.topics,
    data: event.data
  };
}
