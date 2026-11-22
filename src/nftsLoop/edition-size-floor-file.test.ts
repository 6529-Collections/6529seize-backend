import { MEMES_CONTRACT } from '@/constants';
import { resolveNftEditionSizeFloor } from '@/nftsLoop/nfts';
import RECORDED from './memes-edition-size-floors.json';

const meme = (id: number, supply: number, floor: number) => ({
  contract: MEMES_CONTRACT,
  id,
  supply,
  edition_size_floor: floor
});

describe('recorded Memes edition-size floors', () => {
  const env = process.env;

  afterEach(() => {
    process.env = env;
  });

  it('give a rebuilt row the floor 6529.io holds; a floor read from the chain still wins', () => {
    process.env = { ...env, FEATURE_ETH_INDEX_REBUILD_FIXES: 'true' };
    // A rebuilt row starts at its supply; the recorded floor replaces it.
    expect(
      resolveNftEditionSizeFloor(meme(12, 300, 300), {}, { 12: 320 })
    ).toBe(320);
    // A floor read from the chain this run still wins.
    expect(
      resolveNftEditionSizeFloor(meme(12, 300, 300), { 12: 330 }, { 12: 320 })
    ).toBe(330);
    // No recorded floor: as before.
    expect(resolveNftEditionSizeFloor(meme(13, 300, 310), {}, {})).toBe(310);
  });

  it('are ignored with the flag off', () => {
    process.env = { ...env };
    delete process.env.FEATURE_ETH_INDEX_REBUILD_FIXES;
    expect(resolveNftEditionSizeFloor(meme(12, 300, 0), {})).toBe(300);
  });

  it('are a map of Meme token id to a positive whole floor', () => {
    for (const [id, floor] of Object.entries(
      RECORDED as Record<string, number>
    )) {
      expect(Number.isInteger(Number(id)) && Number(id) > 0).toBe(true);
      expect(Number.isInteger(floor) && floor > 0).toBe(true);
    }
  });
});
