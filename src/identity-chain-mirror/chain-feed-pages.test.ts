import { ChainGatewayError } from '@/chain-gateway/chain-gateway.client';
import { ChainFeedBlock } from '@/chain-gateway/chain-gateway.types';
import { covers } from './identity-chain-mirror.service';
import { readFeedPage, readWholeBlocks } from './chain-feed-pages';

function record(key: string) {
  return { family: '0x0104', name: 'Profile', key, value: '0x01' };
}

function block(
  height: number,
  keys: string[],
  complete = true
): ChainFeedBlock {
  return {
    height,
    slot: height,
    root: '0x',
    time: height,
    complete,
    records: keys.map(record)
  };
}

function page(
  from: number | string,
  through: number,
  next: number | string,
  blocks: ChainFeedBlock[]
) {
  const height = Number(String(from).split(':')[0]);
  return {
    from,
    through,
    next,
    blocks,
    nextHeight: through + 1,
    atHead: !blocks.length && through < height
  };
}

const noWait = async () => undefined;

describe('readWholeBlocks', () => {
  it('reads a block a page ended inside to its end, once', async () => {
    const getChanges = jest
      .fn()
      .mockResolvedValueOnce(
        page(10, 11, '12:2', [block(11, ['a']), block(12, ['b', 'c'], false)])
      )
      .mockResolvedValueOnce(
        page('12:2', 13, 14, [
          { ...block(12, ['d']), recordsFrom: 2 },
          block(13, ['e'])
        ])
      );
    const read = await readWholeBlocks({ getChanges }, 10, { limit: 200 });
    expect(read?.nextHeight).toBe(14);
    expect(
      read?.blocks.map((it) => [it.height, it.records.map((r) => r.key)])
    ).toEqual([
      [11, ['a']],
      [12, ['b', 'c', 'd']],
      [13, ['e']]
    ]);
    expect(getChanges).toHaveBeenNthCalledWith(2, '12:2', { limit: 200 });
  });

  it.each([
    ['a node behind', page('12:2', 11, '12:2', [])],
    ['a page that does not move on', page('12:2', 11, '12:2', [block(12, [])])],
    ['another block', page('12:2', 13, 14, [block(13, ['e'])])],
    [
      'the block again from another position',
      page('12:2', 12, 13, [{ ...block(12, ['b', 'c']), recordsFrom: 0 }])
    ]
  ])('leaves a cut block out, to read again, after %s', async (_name, rest) => {
    const getChanges = jest
      .fn()
      .mockResolvedValueOnce(
        page(10, 11, '12:2', [block(11, ['a']), block(12, ['b'], false)])
      )
      .mockResolvedValueOnce(rest);
    const read = await readWholeBlocks({ getChanges }, 10, { limit: 200 });
    expect(read).toEqual({
      blocks: [block(11, ['a'])],
      nextHeight: 12,
      atHead: false,
      network: null
    });
  });

  it('leaves a cut block out when the rest is gone', async () => {
    const gone = new ChainGatewayError('gone', 410, 'gone', '/v1/feed');
    const getChanges = jest
      .fn()
      .mockResolvedValueOnce(page(12, 11, '12:2', [block(12, ['b'], false)]))
      .mockRejectedValue(gone);
    const read = await readWholeBlocks({ getChanges }, 12, {
      limit: 200,
      sleep: noWait
    });
    expect(read).toEqual({
      blocks: [],
      nextHeight: 12,
      atHead: false,
      network: null
    });
  });

  it('says the head is reached, and null when the start is gone', async () => {
    const atHead = jest.fn().mockResolvedValueOnce(page(20, 19, 20, []));
    expect(
      await readWholeBlocks({ getChanges: atHead }, 20, { limit: 5 })
    ).toEqual({ blocks: [], nextHeight: 20, atHead: true, network: null });
    const gone = jest
      .fn()
      .mockRejectedValue(
        new ChainGatewayError('gone', 410, 'gone', '/v1/feed')
      );
    expect(
      await readWholeBlocks({ getChanges: gone }, 20, {
        limit: 5,
        sleep: noWait
      })
    ).toBeNull();
    expect(gone).toHaveBeenCalledTimes(3);
  });
});

describe('covers', () => {
  it('needs every height from the start to the end without a gap', () => {
    expect(covers([[1, 100]], 1, 50)).toBe(true);
    expect(
      covers(
        [
          [1, 10],
          [11, 60]
        ],
        1,
        50
      )
    ).toBe(true);
    expect(
      covers(
        [
          [1, 10],
          [12, 60]
        ],
        1,
        50
      )
    ).toBe(false);
    expect(covers([[5, 100]], 1, 50)).toBe(false);
    expect(covers([[1, 40]], 1, 50)).toBe(false);
    expect(covers([], 1, 1)).toBe(false);
  });
});

describe('readFeedPage', () => {
  it('waits longer between each gone and stops at the third', async () => {
    const waits: number[] = [];
    const getChanges = jest
      .fn()
      .mockRejectedValue(
        new ChainGatewayError('gone', 410, 'gone', '/v1/feed')
      );
    expect(
      await readFeedPage({ getChanges }, 5, {
        limit: 10,
        sleep: async (ms) => {
          waits.push(ms);
        }
      })
    ).toBeNull();
    expect(waits).toEqual([500, 1000]);
  });

  it('throws any other refusal', async () => {
    const getChanges = jest
      .fn()
      .mockRejectedValue(
        new ChainGatewayError('no', 400, 'bad_request', '/v1/feed')
      );
    await expect(
      readFeedPage({ getChanges }, 5, { limit: 10 })
    ).rejects.toMatchObject({ code: 'bad_request' });
  });
});
