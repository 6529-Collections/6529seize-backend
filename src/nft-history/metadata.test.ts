import fc from 'fast-check';
import { describeHistoryEdit, diffHistoryMetadata } from './metadata';

afterEach(() => jest.restoreAllMocks());

it('describes the October 26 removal of animation_details without throwing', () => {
  const result = diffHistoryMetadata(
    {
      image: 'old-image',
      animation: 'movie',
      animation_url: 'movie',
      animation_details: { format: 'MP4', duration: 6, codecs: ['avc1'] },
      image_details: { width: 1200, height: 1200 }
    },
    { image: 'new-image', image_details: { width: 6937, height: 4624 } }
  );
  expect(result.changes).toEqual(
    expect.arrayContaining([
      { key: 'animation', from: 'movie', to: '' },
      { key: 'animation_url', from: 'movie', to: '' },
      { key: 'animation_details::format', from: 'MP4', to: '' },
      { key: 'animation_details::codecs', from: ['avc1'], to: '' },
      { key: 'image_details::width', from: 1200, to: 6937 }
    ])
  );
});

it('handles added/removed attributes and preserves falsy values', () => {
  expect(
    diffHistoryMetadata(
      {
        enabled: true,
        number: 0,
        attributes: [{ trait_type: 'Old', value: 1 }]
      },
      {
        enabled: false,
        number: 1,
        attributes: [{ trait_type: 'New', value: 0 }]
      }
    ).changes
  ).toEqual(
    expect.arrayContaining([
      { key: 'enabled', from: true, to: false },
      { key: 'number', from: 0, to: 1 },
      { key: 'attributes::Old (Removed)', from: 1, to: '' },
      { key: 'attributes::New (Added)', from: '', to: 0 }
    ])
  );
});

it('is reflexive for arbitrary JSON metadata', () => {
  fc.assert(
    fc.property(
      fc.dictionary(
        fc.string().filter((key) => key !== 'attributes'),
        fc.jsonValue()
      ),
      (metadata) => {
        expect(diffHistoryMetadata(metadata, metadata).changes).toEqual([]);
      }
    )
  );
});

it('skips an unchanged URI but fetches paths that differ only by case', async () => {
  const fetchMock = jest
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async () => new Response('{"name":"same"}'));
  expect(
    await describeHistoryEdit(
      'https://arweave.net/AbC',
      'https://arweave.net/AbC'
    )
  ).toBeNull();
  expect(fetchMock).not.toHaveBeenCalled();
  expect(
    await describeHistoryEdit(
      'https://arweave.net/AbC',
      'https://arweave.net/abc'
    )
  ).toEqual({ event: 'Edit', changes: [] });
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
