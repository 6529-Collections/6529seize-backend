import {
  GRADIENT_CONTRACT,
  MEMELAB_CONTRACT,
  MEMES_CONTRACT
} from './constants';
import { Artist } from './entities/IArtist';
import { BaseNFT } from './entities/INFT';
import { areEqualAddresses } from './helpers';
import { Logger } from './logging';

const logger = Logger.get('ARTISTS');

function splitArtists(artist: string) {
  const a = artist
    .split(' / ')
    .join(',')
    .split(', ')
    .join(',')
    .split(' and ')
    .join(',')
    .split(',');
  return a;
}

export const processArtists = async (
  startingArtists: Artist[],
  nfts: BaseNFT[]
) => {
  const artists: Artist[] = [];

  logger.info(`[PROCESSING ARTISTS FOR ${nfts.length} NFTS]`);

  nfts.forEach((nft) => {
    const artistNames = splitArtists(nft.artist);

    artistNames.forEach((artistName) => {
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
        const memelab = areEqualAddresses(nft.contract, MEMELAB_CONTRACT)
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
        const artist: Artist = {
          name: artistName,
          memes: memes,
          memelab: memelab,
          gradients: gradients,
          work: [],
          social_links: []
        };
        artists.push(artist);
      } else {
        let artist = artists.find((a) => a.name == artistName);

        if (!artist) {
          artist = startingArtists.find((a) => a.name == artistName);
        }

        if (artist) {
          if (areEqualAddresses(nft.contract, MEMES_CONTRACT)) {
            const memesNft = {
              id: nft.id,
              collboration_with: [...artistNames.filter((n) => n != artistName)]
            };
            if (!artist.memes.some((m) => m.id == nft.id)) {
              artist.memes.push(memesNft);
            }
          }
          if (areEqualAddresses(nft.contract, GRADIENT_CONTRACT)) {
            if (!artist.gradients.includes(nft.id)) {
              artist.gradients.push(nft.id);
            }
          }
          if (areEqualAddresses(nft.contract, MEMELAB_CONTRACT)) {
            const labNft = {
              id: nft.id,
              collboration_with: [...artistNames.filter((n) => n != artistName)]
            };
            if (artist.memelab) {
              if (!artist.memelab.some((ml) => ml.id == nft.id)) {
                artist.memelab.push(labNft);
              }
            } else {
              artist.memelab = [labNft];
            }
          }

          if (artists.some((a) => a.name == artistName)) {
            artists.forEach((a) => {
              if (a.name == artistName) {
                a = artist!;
              }
            });
          } else {
            artists.push(artist);
          }
        }
      }
    });
  });

  return artists;
};
