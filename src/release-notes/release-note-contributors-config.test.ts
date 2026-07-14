import { GITHUB_TO_6529_HANDLES } from './release-note-contributors.config';

describe('GITHUB_TO_6529_HANDLES', () => {
  it('maps GitHub contributors to their 6529.io handles', () => {
    expect(GITHUB_TO_6529_HANDLES).toEqual({
      brookr: 'brookr',
      gelatogenesis: 'GelatoGenesis',
      prxt6529: 'prxt0',
      punk6529: 'punk6529',
      ragnep: 'ragne',
      simo6529: 'simo'
    });
  });
});
