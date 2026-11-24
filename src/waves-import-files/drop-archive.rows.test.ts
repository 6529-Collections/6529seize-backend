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

  it('takes those columns from a line that carries them', () => {
    const line = {
      ...firstLine(),
      signature: 'sig',
      is_additional_action_promised: true,
      hide_link_preview: true,
      collapse_replies: true
    };
    expect(dropArchiveRows(line, FIXTURE_WAVES.a).drop).toMatchObject({
      signature: 'sig',
      is_additional_action_promised: true,
      hide_link_preview: true,
      collapse_replies: true
    });
    expect(reasonOf({ ...firstLine(), hide_link_preview: 'yes' })).toBe(
      'hide_link_preview has the wrong type'
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
      'serial_no is not an integer of at least 1'
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
