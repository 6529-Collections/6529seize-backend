import { ipfsMintContent } from './mint-log-content';
import {
  mintLogEntries,
  mintRebuiltTables,
  rebuildMintLog,
  setMintRecordLogSource
} from './mint-log-rebuild.run';

describe('mint log rebuild from the record log', () => {
  it('takes only the mint log entries, in log order', async () => {
    async function* items() {
      yield { entry: { t: 'event', lane: 'mint' } as any };
      yield { entry: { t: 'entry', lane: 'mint', body: { seq: 0 } } as any };
      yield { entry: { t: 'entry', lane: 'waves', body: { seq: 9 } } as any };
      yield { entry: { t: 'entry', lane: 'mint', body: { seq: 1 } } as any };
    }
    const seen: unknown[] = [];
    for await (const body of mintLogEntries(items())) seen.push(body);
    expect(seen).toEqual([{ seq: 0 }, { seq: 1 }]);
  });

  it('lists every table it writes whole, and not the subscription rows', () => {
    const tables = mintRebuiltTables();
    expect(tables).toEqual(
      expect.arrayContaining([
        'distribution',
        'minting_claims',
        'minting_merkle_proofs',
        'meme_collaborations',
        'rememes',
        'mint_log_head',
        'mint_log_card_heads'
      ])
    );
    expect(tables).not.toContain('subscriptions_nfts_final');
  });

  it('says what is missing when no record log source is bound', async () => {
    setMintRecordLogSource(null);
    await expect(rebuildMintLog()).rejects.toThrow(
      'No record log source is bound'
    );
  });

  it('reads genesis files through the files source', async () => {
    const fetchImpl = jest.fn(
      async () => new Response(Buffer.from('gz'), { status: 200 })
    );
    const content = ipfsMintContent('https://files.example/', fetchImpl as any);
    await expect(content.get('bafy123')).resolves.toEqual(Buffer.from('gz'));
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://files.example/ipfs/bafy123',
      expect.any(Object)
    );
    await expect(content.get('../x')).rejects.toThrow('Not a CID');
    fetchImpl.mockResolvedValueOnce(new Response('', { status: 404 }));
    await expect(content.get('bafy404')).rejects.toThrow('HTTP 404');
  });
});
