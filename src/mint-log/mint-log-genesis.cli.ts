import { ipfsMintContent } from './mint-log-content';
import { getMintLogPorts } from './mint-log-ports';
import {
  GENESIS_CHAINS,
  MintContentPort,
  mintGenesisReader,
  runMintGenesis
} from './mint-log-genesis';
import { chainOfCard, MintLogChain } from './mint-log.types';

/**
 * `mint-log:genesis`: writes the mint log's genesis files to IPFS and appends
 * the genesis entries. Without `--live` it is a read-only dry run that counts
 * the cards of each chain. Run with `--live` once, right after
 * MINT_LOG_SHADOW is on. `--chain mint|rememes|collab` limits it to one chain.
 */

const ipfsContent: MintContentPort = ipfsMintContent();

export async function main(args = process.argv.slice(2)): Promise<void> {
  if (args.includes('--help')) {
    process.stdout.write(
      'mint-log:genesis [--live] [--chain mint|rememes|collab]\nDefaults to a read-only dry run that counts the cards of each chain. --live writes the files to IPFS and appends the genesis entries.\n'
    );
    return;
  }
  const chainAt = args.indexOf('--chain');
  const chain = chainAt >= 0 ? args[chainAt + 1] : undefined;
  if (chainAt >= 0 && !GENESIS_CHAINS.includes(chain as MintLogChain)) {
    throw new Error('--chain takes mint, rememes or collab');
  }
  const unknown = args.filter(
    (arg, index) =>
      arg !== '--live' && index !== chainAt && index !== chainAt + 1
  );
  if (unknown.length) throw new Error('Invalid arguments; use --help');
  const live = args.includes('--live');
  const chains = chain ? [chain as MintLogChain] : GENESIS_CHAINS;
  const { doInDbContext } = await import('@/secrets');
  const { dbSupplier } = await import('@/sql-executor');
  const output = await doInDbContext(
    async () => {
      if (!live) {
        const cards = await dbSupplier().executeNativeQueriesInTransaction(
          (connection) => mintGenesisReader.cards(connection)
        );
        return {
          live: false,
          cards: Object.fromEntries(
            chains.map((it) => [
              it,
              cards.filter((card) => chainOfCard(card) === it).length
            ])
          )
        };
      }
      const log = getMintLogPorts().log;
      if (!log) {
        throw new Error(
          'No record log is bound: deploy the signed-records module first'
        );
      }
      const entries = await runMintGenesis({
        content: ipfsContent,
        log,
        chains
      });
      return {
        live: true,
        entries: entries.map((entry) => ({
          chain: entry.chain,
          seq: entry.seq,
          card: entry.card?.key ?? null,
          cards: (entry.inputs.cards as unknown[]).length,
          distribution_cursor_block:
            entry.inputs.distribution_cursor_block ?? null
        }))
      };
    },
    { syncEntities: false, skipRedis: true }
  );
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

if (require.main === module)
  void main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'Mint log genesis failed'}\n`
    );
    process.exitCode = 1;
  });
