import { checkPreview } from './moderation-review-preview';

const now = 1_800_000_000_000;
function preview(
  evidence: Record<string, unknown> | null,
  expires: number | null = null
) {
  return checkPreview({ evidence, evidence_expires_at: expires });
}

describe('retained moderation previews', () => {
  beforeEach(() => jest.spyOn(Date, 'now').mockReturnValue(now));
  afterEach(() => jest.restoreAllMocks());

  it('shows retained post parts with the title in saved order', () => {
    expect(
      preview({
        title: 'Reported post',
        parts: [{ content: 'First part' }, { content: 'Second part' }]
      })
    ).toBe('Reported post\nFirst part\nSecond part');
  });

  it('shows titleless post evidence instead of reporting no preview', () => {
    expect(
      preview({ title: null, parts: [{ content: 'Deleted post text' }] })
    ).toBe('Deleted post text');
  });

  it('preserves public text precedence and bounds combined post previews', () => {
    expect(
      preview({
        text: 'Public text',
        title: 'Title',
        parts: [{ content: 'Body' }]
      })
    ).toBe('Public text');
    expect(
      preview({ title: 'Title', parts: [{ content: 'x'.repeat(200) }] })
    ).toBe(('Title\n' + 'x'.repeat(200)).slice(0, 160));
    expect(preview({ text: 'x'.repeat(200) })).toHaveLength(160);
  });

  it('ignores malformed and nontext parts while retaining valid content', () => {
    expect(
      preview({
        text: 123,
        title: false,
        parts: [
          null,
          'not a part',
          123,
          {},
          { content: 123 },
          { content: '   ' },
          { content: 'Saved text' }
        ]
      })
    ).toBe('Saved text');
    expect(
      preview({ title: 'Title', parts: { content: 'Not an array' } })
    ).toBe('Title');
  });

  it.each([
    { evidence: null, expires: null },
    {
      evidence: {
        parts: [{ content: 'Expired post' }],
        evidence_expired: true
      },
      expires: null
    },
    { evidence: { parts: [{ content: 'Expired post' }] }, expires: now },
    {
      evidence: {
        title: 'Expired title',
        parts: [{ content: 'Expired post' }]
      },
      expires: now - 1
    }
  ])(
    'never exposes absent or expired evidence: %j',
    ({ evidence, expires }) => {
      expect(preview(evidence, expires)).toBeNull();
    }
  );

  it('permits unexpired evidence and returns null for content without text', () => {
    expect(preview({ parts: [{ content: 'Still retained' }] }, now + 1)).toBe(
      'Still retained'
    );
    expect(
      preview({ title: '', parts: [{ media: [{ url: 'image.png' }] }] })
    ).toBeNull();
    expect(preview({ text: ' ', title: '\n', parts: [] })).toBeNull();
  });
});
