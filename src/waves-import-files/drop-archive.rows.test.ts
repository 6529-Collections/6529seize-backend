import { buildDropArchives } from '@/waves-import-files/drop-archive.build';
import {
  DropArchiveLineError,
  dropArchiveRows
} from '@/waves-import-files/drop-archive.rows';
import {
  FIXTURE_DROPS,
  FIXTURE_PARTS,
  FIXTURE_WAVES
} from '@/tests/fixtures/drop-archive.fixture';

function firstLine(): Record<string, unknown> {
  const [a] = buildDropArchives(FIXTURE_DROPS, FIXTURE_PARTS).archives;
  return JSON.parse(a.bytes.toString('utf8').split('\n')[0]);
}

function reasonOf(line: unknown): string {
  try {
    dropArchiveRows(line, FIXTURE_WAVES.a);
  } catch (error) {
    expect(error).toBeInstanceOf(DropArchiveLineError);
    return (error as Error).message;
  }
  return 'accepted';
}

describe('dropArchiveRows', () => {
  it("gives the columns the archive doesn't carry their defaults", () => {
    const { drop } = dropArchiveRows(firstLine(), FIXTURE_WAVES.a);
    expect(drop).toMatchObject({
      signature: null,
      is_additional_action_promised: null,
      hide_link_preview: false,
      collapse_replies: false
    });
  });

  it("takes the drops table's own values from a line that carries them", () => {
    const table = {
      signature: 'sig',
      is_additional_action_promised: true,
      hide_link_preview: true,
      collapse_replies: true,
      drop_type: 'COMPETITION',
      reply_to_part_id: null
    };
    // A reply the API shows with part 0, a native entry it shows as
    // PARTICIPATORY: the table's values win.
    const line = {
      ...firstLine(),
      drop_type: 'PARTICIPATORY',
      reply_to: { drop_id: FIXTURE_DROPS[1].id, part_id: 0 },
      table
    };
    expect(dropArchiveRows(line, FIXTURE_WAVES.a).drop).toMatchObject({
      ...table,
      reply_to_drop_id: FIXTURE_DROPS[1].id
    });
    expect(
      dropArchiveRows({ ...firstLine(), table: null }, FIXTURE_WAVES.a).drop
    ).toMatchObject({ signature: null, hide_link_preview: false });
    expect(
      reasonOf({ ...line, table: { ...table, hide_link_preview: 'yes' } })
    ).toBe('table hide_link_preview has the wrong type');
    expect(reasonOf({ ...line, table: { ...table, drop_type: 'POLL' } })).toBe(
      'table drop_type has the wrong type'
    );
    expect(
      reasonOf({ ...line, table: { ...table, reply_to_part_id: -1 } })
    ).toBe('table reply_to_part_id has the wrong type');
    expect(reasonOf({ ...line, table: 'x' })).toBe('table is not an object');
    expect(reasonOf({ ...line, table: { ...table, note: 'x' } })).toBe(
      'table has a key it should not'
    );
  });

  it("refuses table values that disagree with the line's API view", () => {
    const table = {
      signature: null,
      is_additional_action_promised: null,
      hide_link_preview: false,
      collapse_replies: false,
      drop_type: 'CHAT',
      reply_to_part_id: null
    };
    const reply = { drop_id: FIXTURE_DROPS[1].id, part_id: 3 };
    const accepted = (line: Record<string, unknown>) =>
      dropArchiveRows(line, FIXTURE_WAVES.a).drop;
    // An entry's type shown as the entry's state: agrees.
    for (const [tableType, apiType] of [
      ['COMPETITION', 'CHAT'],
      ['COMPETITION', 'WINNER'],
      ['PARTICIPATORY', 'WINNER'],
      ['WINNER', 'PARTICIPATORY']
    ]) {
      expect(
        accepted({
          ...firstLine(),
          drop_type: apiType,
          table: { ...table, drop_type: tableType }
        }).drop_type
      ).toBe(tableType);
    }
    // The facade never shows a chat drop as an entry's.
    expect(
      reasonOf({
        ...firstLine(),
        drop_type: 'WINNER',
        table: { ...table, drop_type: 'CHAT' }
      })
    ).toBe("table drop_type disagrees with the line's");
    expect(
      reasonOf({
        ...firstLine(),
        drop_type: 'PARTICIPATORY',
        table: { ...table, drop_type: 'CHAT' }
      })
    ).toBe("table drop_type disagrees with the line's");
    // A reply part only on a reply, equal to the API's (none shows as 0).
    expect(
      reasonOf({
        ...firstLine(),
        reply_to: null,
        table: { ...table, reply_to_part_id: 3 }
      })
    ).toBe("table reply part disagrees with the line's");
    expect(
      reasonOf({
        ...firstLine(),
        reply_to: reply,
        table: { ...table, reply_to_part_id: 5 }
      })
    ).toBe("table reply part disagrees with the line's");
    expect(
      accepted({
        ...firstLine(),
        reply_to: reply,
        table: { ...table, reply_to_part_id: 3 }
      }).reply_to_part_id
    ).toBe(3);
    expect(
      accepted({
        ...firstLine(),
        reply_to: { ...reply, part_id: 0 },
        table
      }).reply_to_part_id
    ).toBeNull();
    // The line's own reply part is checked with table values too.
    expect(
      reasonOf({
        ...firstLine(),
        reply_to: { ...reply, part_id: '3' },
        table: { ...table, reply_to_part_id: 3 }
      })
    ).toBe('reply_to part is not an integer of at least 0');
  });

  it('takes any integer serial: 6529.io holds a few negative ones', () => {
    expect(
      dropArchiveRows({ ...firstLine(), serial_no: -3 }, FIXTURE_WAVES.a).drop
        .serial_no
    ).toBe(-3);
  });

  it('counts a title in characters, as MySQL does', () => {
    const wave = '\u{1F30A}';
    expect(
      dropArchiveRows(
        { ...firstLine(), title: wave.repeat(250) },
        FIXTURE_WAVES.a
      ).drop.title
    ).toBe(wave.repeat(250));
    expect(reasonOf({ ...firstLine(), title: wave.repeat(251) })).toBe(
      'title is not a title'
    );
  });

  it('refuses a line that is not a v1 drop of the wave', () => {
    const line = firstLine();
    expect(reasonOf(null)).toBe('the line is not an object');
    expect(reasonOf({ ...line, v: 2 })).toBe('the line is not format v1');
    expect(reasonOf({ ...line, wave_id: FIXTURE_WAVES.b })).toBe(
      'the drop is of another wave'
    );
    expect(reasonOf({ ...line, drop_id: '' })).toBe('drop_id is not an id');
    expect(reasonOf({ ...line, drop_id: 'x'.repeat(101) })).toBe(
      'drop_id is not an id'
    );
    expect(reasonOf({ ...line, serial_no: 0 })).toBe(
      'serial_no is 0, which the table would renumber'
    );
    expect(reasonOf({ ...line, serial_no: 1.5 })).toBe(
      'serial_no is not an integer'
    );
    expect(reasonOf({ ...line, serial_no: '7' })).toBe(
      'serial_no is not an integer'
    );
    expect(reasonOf({ ...line, created_at: '1' })).toBe(
      'created_at is not an integer of at least 0'
    );
    expect(reasonOf({ ...line, drop_type: 'POLL' })).toBe(
      'drop_type is not a drop type'
    );
    expect(reasonOf({ ...line, title: 'x'.repeat(251) })).toBe(
      'title is not a title'
    );
    expect(reasonOf({ ...line, author: null })).toBe('author is not an id');
    expect(reasonOf({ ...line, parts: {} })).toBe('parts is not a list');
    expect(
      reasonOf({
        ...line,
        parts: [
          { part_id: 1, content: 'a', quoted_drop: null },
          { part_id: 1, content: 'b', quoted_drop: null }
        ]
      })
    ).toBe('two parts share a part_id');
    expect(
      reasonOf({
        ...line,
        parts: [{ part_id: 1, content: 2, quoted_drop: null }]
      })
    ).toBe('part 1 content');
    expect(reasonOf({ ...line, reply_to: 'x' })).toBe(
      'reply_to is not an object'
    );
  });
});
