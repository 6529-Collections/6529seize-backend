import { main } from '@/profile-cms/chain/profile-cms-chain-sync.cli';
import { ProfileCmsChainFollower } from '@/profile-cms/chain/profile-cms-chain-follower';
import { profileCmsChainDb } from '@/profile-cms/chain/profile-cms-chain.db';
import { ProfileCmsChainParkedEntity } from '@/entities/IProfileCmsChainParked';
import {
  aChainIdentity,
  aProfileDoc,
  InMemoryProfileCmsChain
} from '@/tests/fixtures/profile-cms-chain.fixture';

describe('profile-cms:chain-sync', () => {
  afterEach(() => jest.restoreAllMocks());

  function deps(port = new InMemoryProfileCmsChain()) {
    const written: string[] = [];
    return {
      written,
      deps: {
        createPort: () => port,
        inDb: <T>(fn: () => Promise<T>) => fn(),
        write: (text: string) => {
          written.push(text);
        }
      }
    };
  }

  it('syncs from the given height through the port', async () => {
    const sync = jest
      .spyOn(ProfileCmsChainFollower.prototype, 'syncFrom')
      .mockResolvedValue({ applied: 3, nextHeight: 131, waiting: 0 });
    const run = deps();
    const result = await main(['--from-height', '100'], run.deps);
    expect(result).toEqual({ applied: 3, nextHeight: 131, waiting: 0 });
    expect(sync).toHaveBeenCalledTimes(1);
    expect(sync).toHaveBeenCalledWith(100, {});
    expect(run.written).toEqual([
      'applied 3 Profile changes; next height 131\n'
    ]);
  });

  it('syncs again, retrying the parked changes, until none waits', async () => {
    const sync = jest
      .spyOn(ProfileCmsChainFollower.prototype, 'syncFrom')
      .mockResolvedValueOnce({ applied: 2, nextHeight: 120, waiting: 1 })
      .mockResolvedValueOnce({ applied: 1, nextHeight: 131, waiting: 0 });
    const run = deps();
    const result = await main(['--from-height', '100'], run.deps);
    expect(sync.mock.calls).toEqual([
      [100, {}],
      [120, {}]
    ]);
    expect(result).toEqual({ applied: 3, nextHeight: 131, waiting: 0 });
  });

  it('fails when a change stays unreadable, instead of serving no site', async () => {
    const chain = new InMemoryProfileCmsChain();
    chain.setIdentity(aChainIdentity({ imported: false }));
    chain.replaceProfile({
      version: 1,
      height: 10,
      timeMs: 1000,
      doc: aProfileDoc()
    });
    jest.spyOn(chain, 'getProfileDoc').mockResolvedValue({ status: 'missing' });
    const tries: number[] = [];
    let parked: ProfileCmsChainParkedEntity | null = null;
    jest.spyOn(profileCmsChainDb, 'findHead').mockResolvedValue(null);
    jest
      .spyOn(profileCmsChainDb, 'listParked')
      .mockImplementation(async () => (parked ? [parked] : []));
    jest
      .spyOn(profileCmsChainDb, 'findParked')
      .mockImplementation(async () => parked);
    jest
      .spyOn(profileCmsChainDb, 'park')
      .mockImplementation(async (change, wait) => {
        tries.push(wait.attempts);
        parked = {
          principal: change.principal,
          version: change.version,
          height: change.height,
          time_ms: change.time_ms,
          doc_cid: change.doc_cid,
          source: null,
          attempts: wait.attempts,
          reason: wait.reason,
          parked_at: wait.now,
          alerted_at: null
        };
      });
    await expect(
      main(['--from-height', '0'], deps(chain).deps)
    ).rejects.toThrow('Profile site rebuild stopped');
    expect(tries).toEqual([1, 2, 3, 4]);
  });

  it.each([
    [[]],
    [['--from-height', 'x']],
    [['--from-height']],
    [['--gateway', 'x']],
    [['--from-height', '1', '--gateway', 'x']]
  ])('refuses %j', async (args) => {
    await expect(main(args, deps().deps)).rejects.toThrow(
      'profile-cms:chain-sync'
    );
  });

  it('prints usage', async () => {
    const run = deps();
    expect(await main(['--help'], run.deps)).toBeNull();
    expect(run.written[0]).toContain('--from-height');
  });
});
