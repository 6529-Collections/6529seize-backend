import { competitionCreditNfts } from './competition-credit-nfts';

it('serializes deduplicated NFT credits with the keys consumed by JSON_TABLE', () => {
  const contract = `0x${'ab'.repeat(20)}`;
  const voting = {
    credit_nfts: [
      { contract: contract.toUpperCase().replace('0X', '0x'), token_id: 2 },
      { contract, tokenId: 1 },
      { contract, token_id: 2 }
    ]
  };
  expect(JSON.parse(JSON.stringify(competitionCreditNfts(voting)))).toEqual([
    { contract, tokenId: 1 },
    { contract, tokenId: 2 }
  ]);
});
