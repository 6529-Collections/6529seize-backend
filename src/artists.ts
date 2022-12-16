import { GRADIENT_CONTRACT, MEMES_CONTRACT } from './constants';
import { Artist } from './entities/IArtist';
import { NFT } from './entities/INFT';
import { areEqualAddresses } from './helpers';

function splitArtists(artist: string) {
  return artist.split(' / ').join(',').split(' and ').join(',').split(',');
}

export const findArtists = async (startingArtists: Artist[], nfts: NFT[]) => {
  const artists: Artist[] = [];

  console.log(
    new Date(),
    '[ARTISTS]',
    `[PROCESSING ARTISTS FOR ${nfts.length} NFTS]`
  );

  nfts.map((nft) => {
    const artistNames = splitArtists(nft.artist);

    artistNames.map((artistName) => {
      if (
        !artists.some((a) => a.name == artistName) &&
        !startingArtists.some((a) => a.name == artistName)
      ) {
        const memes = areEqualAddresses(nft.contract, MEMES_CONTRACT)
          ? [
              {
                id: nft.id,
                collboration_with: [
                  ...artistNames.filter((n) => n != artistName)
                ]
              }
            ]
          : [];
        const gradients = areEqualAddresses(nft.contract, GRADIENT_CONTRACT)
          ? [nft.id]
          : [];
        const artist = {
          name: artistName,
          memes: memes,
          gradients: gradients
        };
        artists.push(artist);
      } else {
        let artist = artists.find((a) => a.name == artistName);

        if (!artist) {
          artist = startingArtists.find((a) => a.name == artistName);
        }

        if (areEqualAddresses(nft.contract, MEMES_CONTRACT)) {
          const memesNft = {
            id: nft.id,
            collboration_with: [...artistNames.filter((n) => n != artistName)]
          };
          artist?.memes.push(memesNft);
        }
        if (areEqualAddresses(nft.contract, GRADIENT_CONTRACT)) {
          artist?.gradients.push(nft.id);
        }
      }
    });
  });

  return artists;
};
