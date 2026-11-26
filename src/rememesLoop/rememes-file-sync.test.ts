import { Rememe, RememeSource } from '@/entities/IRememe';
import { rememesMissingFromFile } from './rememes-file-sync';

const CONTRACT = '0x00000000000000000000000000000000000000aa';

function rememe(id: string, source: RememeSource): Rememe {
  return { contract: CONTRACT, id, source } as Rememe;
}

describe('rememesMissingFromFile', () => {
  const rows = [
    rememe('1', RememeSource.FILE),
    rememe('2', RememeSource.FILE),
    rememe('3', RememeSource.SEIZE)
  ];
  const file = [{ contract: CONTRACT.toUpperCase(), id: '1' }];

  it('keeps rememes people added when keepAdded is on', () => {
    expect(rememesMissingFromFile(rows, file, true).map((r) => r.id)).toEqual([
      '2'
    ]);
  });

  it('removes every row missing from the file when keepAdded is off', () => {
    expect(rememesMissingFromFile(rows, file, false).map((r) => r.id)).toEqual([
      '2',
      '3'
    ]);
  });

  it('matches contracts without regard to case', () => {
    expect(rememesMissingFromFile([rows[0]], file, true)).toEqual([]);
  });
});
