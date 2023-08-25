import { GRADIENT_CONTRACT, MEMES_CONTRACT } from './constants';
import { NFT } from './entities/INFT';
import { ConsolidatedOwnerTags, Owner, OwnerTags } from './entities/IOwner';
import { areEqualAddresses } from './helpers';
import {
  fetchAllNFTs,
  fetchAllOwners,
  fetchAllOwnerTags,
  fetchConsolidationDisplay,
  persistConsolidatedOwnerTags,
  persistOwnerTags,
  retrieveWalletConsolidations
} from './db';

export const findOwnerTags = async () => {
  const nfts = await fetchAllNFTs();
  const startingOwners: Owner[] = await fetchAllOwners();
  const startingOwnerTags: OwnerTags[] = await fetchAllOwnerTags();

  const uniqueOwners = Array.from(
    new Set([...startingOwners].map((item) => item.wallet))
  );

  console.log(
    new Date(),
    `[OWNERS TAGS ${startingOwnerTags.length}]`,
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
  const memesNFTsSzn3 = filterSeason(3, memesNFTs);
  const memesNFTsSzn4 = filterSeason(4, memesNFTs);

  const ownersTagsDelta: OwnerTags[] = [];

  uniqueOwners.map((owner) => {
    const walletNFTs = [...startingOwners].filter((o) =>
      areEqualAddresses(o.wallet, owner)
    );

    const oTags = buildTagsFromNfts(
      walletNFTs,
      memesNFTs,
      memesNftsGenesis,
      memesNFTsSzn1,
      memesNFTsSzn2,
      memesNFTsSzn3,
      memesNFTsSzn4
    );

    const ownerTags: OwnerTags = {
      wallet: owner,
      ...oTags
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
        existingTags.unique_memes_szn1 != ownerTags.unique_memes_szn1 ||
        existingTags.unique_memes_szn2 != ownerTags.unique_memes_szn2 ||
        existingTags.unique_memes_szn3 != ownerTags.unique_memes_szn3 ||
        existingTags.unique_memes_szn4 != ownerTags.unique_memes_szn4 ||
        existingTags.memes_cards_sets != ownerTags.memes_cards_sets ||
        existingTags.memes_cards_sets_szn1 != ownerTags.memes_cards_sets_szn1 ||
        existingTags.memes_cards_sets_szn2 != ownerTags.memes_cards_sets_szn2 ||
        existingTags.memes_cards_sets_szn3 != ownerTags.memes_cards_sets_szn3 ||
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
  await persistOwnerTags(ownersTagsDelta);

  const consolidatedTags: ConsolidatedOwnerTags[] = [];
  const processedWallets = new Set<string>();
  const ownerTagsForConsolidation = await fetchAllOwnerTags();

  console.log(
    new Date(),
    '[OWNERS TAGS]',
    `[CONSOLIDATING ${ownerTagsForConsolidation.length} WALLETS]`
  );

  await Promise.all(
    ownerTagsForConsolidation.map(async (om) => {
      const wallet = om.wallet;
      const consolidations = await retrieveWalletConsolidations(wallet);
      const display = await fetchConsolidationDisplay(consolidations);
      const consolidationKey = [...consolidations].sort().join('-');

      if (
        !Array.from(processedWallets).some((pw) =>
          areEqualAddresses(wallet, pw)
        )
      ) {
        const walletNFTs = [...startingOwners].filter((o) =>
          consolidations.some((s) => areEqualAddresses(s, o.wallet))
        );

        const processedWalletNfts: Owner[] = [];
        walletNFTs.map((wNft) => {
          const processed = processedWalletNfts.findIndex(
            (pw) =>
              areEqualAddresses(pw.contract, wNft.contract) &&
              pw.token_id == wNft.token_id
          );
          if (processed > -1) {
            processedWalletNfts[processed].balance += wNft.balance;
          } else {
            processedWalletNfts.push(wNft);
          }
        });

        const oTags = buildTagsFromNfts(
          processedWalletNfts,
          memesNFTs,
          memesNftsGenesis,
          memesNFTsSzn1,
          memesNFTsSzn2,
          memesNFTsSzn3,
          memesNFTsSzn4
        );

        const consolidationTag: ConsolidatedOwnerTags = {
          consolidation_display: display,
          consolidation_key: consolidationKey,
          wallets: consolidations,
          ...oTags
        };

        consolidatedTags.push(consolidationTag);
      }
      consolidations.map(async (c) => {
        processedWallets.add(c);
      });
    })
  );

  console.log(
    new Date(),
    '[CONSOLIDATED OWNERS TAGS]',
    `[DELTA ${consolidatedTags.length}]`,
    `[PROCESSED ${Array.from(processedWallets).length}]`
  );
  await persistConsolidatedOwnerTags(consolidatedTags);

  return ownersTagsDelta;
};

function filterSeason(season: number, nfts: NFT[]) {
  return [...nfts].filter(
    (n) =>
      n.metadata!.attributes?.find((a: any) => a.trait_type === 'Type - Season')
        ?.value == season
  );
}

function buildTagsFromNfts(
  walletNFTs: Owner[],
  memesNFTs: NFT[],
  memesNftsGenesis: NFT[],
  memesNFTsSzn1: NFT[],
  memesNFTsSzn2: NFT[],
  memesNFTsSzn3: NFT[],
  memesNFTsSzn4: NFT[]
) {
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
  const walletMemesSzn3 = [...walletMemes].filter((a) =>
    memesNFTsSzn3.some((n) => n.id == a.token_id)
  );
  const walletMemesSzn4 = [...walletMemes].filter((a) =>
    memesNFTsSzn4.some((n) => n.id == a.token_id)
  );

  const walletGradients = [...walletNFTs].filter((n) =>
    areEqualAddresses(n.contract, GRADIENT_CONTRACT)
  );

  let memesCardSets = 0;
  let memesCardSetsMinus1 = 0;
  let memesCardSetsMinus2 = 0;
  let walletMemesSet1: any[] = [];
  let walletMemesSet2: any[] = [];
  if (walletMemes.length == memesNFTs.length) {
    memesCardSets = Math.min.apply(
      Math,
      [...walletMemes].map(function (o) {
        return o.balance;
      })
    );
    walletMemesSet1 = [...walletMemes].filter((n) => n.balance > memesCardSets);
  } else {
    walletMemesSet1 = [...walletMemes];
  }
  if (walletMemesSet1.length == memesNFTs.length - 1) {
    memesCardSetsMinus1 =
      Math.min.apply(
        Math,
        [...walletMemesSet1].map(function (o) {
          return o.balance;
        })
      ) - memesCardSets;
    walletMemesSet2 = [...walletMemesSet1].filter(
      (n) => n.balance > memesCardSetsMinus1
    );
  } else {
    walletMemesSet2 = [...walletMemesSet1];
  }
  if (walletMemesSet2.length == memesNFTs.length - 2) {
    memesCardSetsMinus2 =
      Math.min.apply(
        Math,
        [...walletMemesSet2].map(function (o) {
          return o.balance;
        })
      ) - memesCardSetsMinus1;
  }

  let memesCardSetsSzn1 = 0;
  if (
    memesNFTsSzn1.length > 0 &&
    walletMemesSzn1.length == memesNFTsSzn1.length
  ) {
    memesCardSetsSzn1 = Math.min.apply(
      Math,
      [...walletMemesSzn1].map(function (o) {
        return o.balance;
      })
    );
  }
  let memesCardSetsSzn2 = 0;
  if (
    memesNFTsSzn2.length > 0 &&
    walletMemesSzn2.length == memesNFTsSzn2.length
  ) {
    memesCardSetsSzn2 = Math.min.apply(
      Math,
      [...walletMemesSzn2].map(function (o) {
        return o.balance;
      })
    );
  }
  let memesCardSetsSzn3 = 0;
  if (
    memesNFTsSzn3.length > 0 &&
    walletMemesSzn3.length == memesNFTsSzn3.length
  ) {
    memesCardSetsSzn3 = Math.min.apply(
      Math,
      [...walletMemesSzn3].map(function (o) {
        return o.balance;
      })
    );
  }

  let memesCardSetsSzn4 = 0;
  if (
    memesNFTsSzn4.length > 0 &&
    walletMemesSzn4.length == memesNFTsSzn4.length
  ) {
    memesCardSetsSzn4 = Math.min.apply(
      Math,
      [...walletMemesSzn4].map(function (o) {
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

  const ownerTags = {
    created_at: new Date(),
    memes_balance: memesBalance,
    unique_memes: walletMemes.length,
    unique_memes_szn1: walletMemesSzn1.length,
    unique_memes_szn2: walletMemesSzn2.length,
    unique_memes_szn3: walletMemesSzn3.length,
    unique_memes_szn4: walletMemesSzn4.length,
    gradients_balance: walletGradients.length,
    genesis: genesis,
    nakamoto: nakamoto,
    memes_cards_sets: memesCardSets,
    memes_cards_sets_minus1: memesCardSetsMinus1,
    memes_cards_sets_minus2: memesCardSetsMinus2,
    memes_cards_sets_szn1: memesCardSetsSzn1,
    memes_cards_sets_szn2: memesCardSetsSzn2,
    memes_cards_sets_szn3: memesCardSetsSzn3,
    memes_cards_sets_szn4: memesCardSetsSzn4
  };
  return ownerTags;
}
