import { RESERVED_HANDLES } from './profiles.constants';

describe('bookmarks route reservation', () => {
  it('prevents a profile handle from taking the bookmarks route', () => {
    expect(RESERVED_HANDLES.map((handle) => handle.toLowerCase())).toContain(
      'bookmarks'
    );
  });
});
