import { Alchemy } from 'alchemy-sdk';
import { ALCHEMY_SETTINGS } from './constants';

let alchemy: Alchemy | null = null;

export function getAlchemyInstance(): Alchemy {
  if (!alchemy) {
    alchemy = new Alchemy({
      ...ALCHEMY_SETTINGS,
      apiKey: process.env.ALCHEMY_API_KEY
    });
  }
  return alchemy;
}
