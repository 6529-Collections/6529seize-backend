import { GRADIENT_CONTRACT, MEMES_CONTRACT } from './constants';
import { NFT } from './entities/INFT';
import { Owner, OwnerTags } from './entities/IOwner';
import { areEqualAddresses } from './helpers';

export const findOwnerTags = async (
  nfts: NFT[],
  startingOwners: Owner[],
  startingOwnerTags: OwnerTags[]
) => {
  const uniqueOwners = Array.from(
    new Set([...startingOwners].map((item) => item.wallet))
  );

  console.log(
    new Date(),
    '[OWNERS TAGS]',
    `[UNIQUE OWNERS ${uniqueOwners.length}]`
  );

  const memesNFTs = [...nfts].filter((n) =>
    areEqualAddresses(n.contract, MEMES_CONTRACT)
  );

  const ownersTagsDelta: OwnerTags[] = [];

  uniqueOwners.map((owner) => {
    const walletNFTs = [...startingOwners].filter((o) =>
      areEqualAddresses(o.wallet, owner)
    );
    const walletMemes = [...walletNFTs].filter((n) =>
      areEqualAddresses(n.contract, MEMES_CONTRACT)
    );
    const walletGradients = [...walletNFTs].filter((n) =>
      areEqualAddresses(n.contract, GRADIENT_CONTRACT)
    );

    let memesCardSets = 0;
    if (walletMemes.length == memesNFTs.length) {
      memesCardSets = Math.min.apply(
        Math,
        [...walletMemes].map(function (o) {
          return o.balance;
        })
      );
    }

    const gen1 = walletMemes.some((a) => a.token_id == 1 && a.balance > 0);
    const gen2 = walletMemes.some((a) => a.token_id == 2 && a.balance > 0);
    const gen3 = walletMemes.some((a) => a.token_id == 3 && a.balance > 0);
    const genesis = gen1 && gen2 && gen3;

    let memesBalance = 0;
    walletMemes.map((a) => {
      memesBalance += a.balance;
    });

    const ownerTags: OwnerTags = {
      created_at: new Date(),
      wallet: owner,
      memes_balance: memesBalance,
      unique_memes: walletMemes.length,
      gradients_balance: walletGradients.length,
      genesis: genesis,
      memes_cards_sets: memesCardSets
    };
    const existingTags = startingOwnerTags.find((o) =>
      areEqualAddresses(o.wallet, owner)
    );

    if (existingTags) {
      if (
        existingTags.genesis != ownerTags.genesis ||
        existingTags.memes_balance != ownerTags.memes_balance ||
        existingTags.gradients_balance != ownerTags.gradients_balance ||
        existingTags.unique_memes != ownerTags.unique_memes ||
        existingTags.memes_cards_sets != ownerTags.memes_cards_sets
      ) {
        ownersTagsDelta.push(ownerTags);
      }
    } else {
      ownersTagsDelta.push(ownerTags);
    }
  });

  console.log(
    new Date(),
    '[OWNERS TAGS]',
    `[UNIQUE TAGS DELTA ${ownersTagsDelta.length}]`
  );

  return ownersTagsDelta;
};
