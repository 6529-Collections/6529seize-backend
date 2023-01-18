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

  const memesNftsGenesis = [...memesNFTs].filter(
    (a) => a.id == 1 || a.id == 2 || a.id == 3
  );
  const memesNFTsSzn1 = filterSeason(1, memesNFTs);
  const memesNFTsSzn2 = filterSeason(2, memesNFTs);

  const ownersTagsDelta: OwnerTags[] = [];

  uniqueOwners.map((owner) => {
    const walletNFTs = [...startingOwners].filter((o) =>
      areEqualAddresses(o.wallet, owner)
    );
    const walletMemes = [...walletNFTs].filter((n) =>
      areEqualAddresses(n.contract, MEMES_CONTRACT)
    );
    const walletMemesGenesis = [...walletMemes].filter(
      (a) => a.token_id == 1 || a.token_id == 2 || a.token_id == 3
    );
    const walletMemesNaka = [...walletMemes].filter((a) => a.token_id == 4);
    const walletMemesSzn1 = [...walletMemes].filter((a) =>
      memesNFTsSzn1.some((n) => n.id == a.token_id)
    );
    const walletMemesSzn2 = [...walletMemes].filter((a) =>
      memesNFTsSzn2.some((n) => n.id == a.token_id)
    );

    const walletGradients = [...walletNFTs].filter((n) =>
      areEqualAddresses(n.contract, GRADIENT_CONTRACT)
    );

    let memesCardSets = 0;
    let memesCardSetsMinus1 = 0;
    let memesCardSetsMinus2 = 0;
    if (walletMemes.length == memesNFTs.length) {
      memesCardSets = Math.min.apply(
        Math,
        [...walletMemes].map(function (o) {
          return o.balance;
        })
      );
    }
    if (walletMemes.length >= memesNFTs.length - 1) {
      memesCardSetsMinus1 = Math.min.apply(
        Math,
        [...walletMemes].map(function (o) {
          return o.balance;
        })
      );
    }
    if (walletMemes.length >= memesNFTs.length - 2) {
      memesCardSetsMinus2 = Math.min.apply(
        Math,
        [...walletMemes].map(function (o) {
          return o.balance;
        })
      );
    }

    let memesCardSetsSzn1 = 0;
    if (walletMemesSzn1.length == memesNFTsSzn1.length) {
      memesCardSetsSzn1 = Math.min.apply(
        Math,
        [...walletMemesSzn1].map(function (o) {
          return o.balance;
        })
      );
    }
    let memesCardSetsSzn2 = 0;
    if (walletMemesSzn2.length == memesNFTsSzn2.length) {
      memesCardSetsSzn2 = Math.min.apply(
        Math,
        [...walletMemesSzn2].map(function (o) {
          return o.balance;
        })
      );
    }

    let genesis = 0;
    if (walletMemesGenesis.length == memesNftsGenesis.length) {
      genesis = Math.min.apply(
        Math,
        [...walletMemesGenesis].map(function (o) {
          return o.balance;
        })
      );
    }

    let nakamoto = 0;
    if (walletMemesNaka.length > 0) {
      nakamoto = Math.min.apply(
        Math,
        [...walletMemesNaka].map(function (o) {
          return o.balance;
        })
      );
    }

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
      nakamoto: nakamoto,
      memes_cards_sets: memesCardSets,
      memes_cards_sets_minus1: memesCardSetsMinus1,
      memes_cards_sets_minus2: memesCardSetsMinus2,
      memes_cards_sets_szn1: memesCardSetsSzn1,
      memes_cards_sets_szn2: memesCardSetsSzn2
    };

    const existingTags = startingOwnerTags.find((o) =>
      areEqualAddresses(o.wallet, owner)
    );

    if (existingTags) {
      if (
        existingTags.genesis != ownerTags.genesis ||
        existingTags.nakamoto != ownerTags.nakamoto ||
        existingTags.memes_balance != ownerTags.memes_balance ||
        existingTags.gradients_balance != ownerTags.gradients_balance ||
        existingTags.unique_memes != ownerTags.unique_memes ||
        existingTags.memes_cards_sets != ownerTags.memes_cards_sets ||
        existingTags.memes_cards_sets_szn1 != ownerTags.memes_cards_sets_szn1 ||
        existingTags.memes_cards_sets_szn2 != ownerTags.memes_cards_sets_szn2 ||
        existingTags.memes_cards_sets_minus1 !=
          ownerTags.memes_cards_sets_minus1 ||
        existingTags.memes_cards_sets_minus2 !=
          ownerTags.memes_cards_sets_minus2
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

function filterSeason(season: number, nfts: NFT[]) {
  return [...nfts].filter(
    (n) =>
      n.metadata!.attributes?.find((a: any) => a.trait_type === 'Type - Season')
        ?.value == season
  );
}
