import { collectCompetitionPages } from '@/competitions/competition-page';

describe('collectCompetitionPages', () => {
  it('collects beyond an internal page without imposing a hidden cap', async () => {
    const values = Array.from({ length: 1001 }, (_, index) => index);
    const read = jest.fn(async ({ offset, limit }) => {
      const data = values.slice(offset, offset + limit);
      return {
        data,
        has_more: offset + data.length < values.length,
        next_cursor: null
      };
    });

    await expect(collectCompetitionPages(read)).resolves.toEqual(values);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('rejects a corrupt page that cannot make progress', async () => {
    await expect(
      collectCompetitionPages(async () => ({
        data: [],
        has_more: true,
        next_cursor: null
      }))
    ).rejects.toThrow('without progress');
  });
});
