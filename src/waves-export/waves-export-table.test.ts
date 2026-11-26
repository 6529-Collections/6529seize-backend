import { dropTableValues, withTableValues } from './waves-export.table';

const ROW = {
  id: 'drop-1',
  signature: null,
  is_additional_action_promised: null,
  hide_link_preview: 0,
  collapse_replies: 0,
  drop_type: 'CHAT',
  reply_to_part_id: null
};

describe('dropTableValues', () => {
  it.each([
    [true, true],
    [false, false],
    [1, true],
    [0, false],
    [2, true],
    ['1', true],
    ['0', false]
  ])('reads the flag %p as %p, as MySQL does', (value, expected) => {
    expect(
      dropTableValues({ ...ROW, hide_link_preview: value }).hide_link_preview
    ).toBe(expected);
  });

  it('keeps an unknown promise null and gives absent flags false', () => {
    expect(
      dropTableValues({
        ...ROW,
        hide_link_preview: null,
        collapse_replies: undefined
      })
    ).toEqual({
      signature: null,
      is_additional_action_promised: null,
      hide_link_preview: false,
      collapse_replies: false,
      drop_type: 'CHAT',
      reply_to_part_id: null
    });
  });

  it('reads a part id given as text as a number', () => {
    expect(
      dropTableValues({ ...ROW, reply_to_part_id: '2' }).reply_to_part_id
    ).toBe(2);
  });
});

describe('withTableValues', () => {
  const table = dropTableValues(ROW);

  it("sets each drop's table values", () => {
    expect(
      withTableValues(
        [{ id: 'drop-1', drop_type: 'CHAT' }],
        new Map([['drop-1', table]])
      )
    ).toEqual([{ id: 'drop-1', drop_type: 'CHAT', table }]);
  });

  it('fails the page when a drop has no table row', () => {
    expect(() =>
      withTableValues(
        [{ id: 'drop-1' }, { id: 'drop-2' }, { id: 'drop-3' }],
        new Map([['drop-1', table]])
      )
    ).toThrow('2 drops of a page have no drops table row (first drop-2)');
  });
});
