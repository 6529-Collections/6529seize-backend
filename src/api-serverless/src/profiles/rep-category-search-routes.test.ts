jest.mock('async-express-decorator', () => (router: unknown) => router, {
  virtual: true
});

import { maybeIncludeHelpBotCreditCategory } from '@/api/profiles/rep-category-search.routes';

describe('rep category search routes', () => {
  it('does not include Help6529 Credits for blank searches', () => {
    expect(maybeIncludeHelpBotCreditCategory([], '')).toEqual([]);
    expect(maybeIncludeHelpBotCreditCategory([], '   ')).toEqual([]);
  });

  it('includes Help6529 Credits only when the search text matches it', () => {
    expect(maybeIncludeHelpBotCreditCategory(['Art'], 'help6529')).toEqual([
      'Help6529 Credits',
      'Art'
    ]);
    expect(maybeIncludeHelpBotCreditCategory(['Art'], 'other')).toEqual([
      'Art'
    ]);
  });

  it('does not duplicate Help6529 Credits when the database already returned it', () => {
    expect(
      maybeIncludeHelpBotCreditCategory(['help6529 credits'], 'help6529')
    ).toEqual(['help6529 credits']);
  });
});
