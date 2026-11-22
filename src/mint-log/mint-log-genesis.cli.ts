import { ipfsFileUploader } from '@/attachments/ipfs-file-uploader';
import { getMintLogPorts } from './mint-log-ports';
import {
  MintContentPort,
  mintGenesisReader,
  runMintGenesis
} from './mint-log-genesis';

/**
 * `mint-log:genesis`: writes the mint log's genesis files to IPFS and appends
 * entry 0. Without `--live` it is a read-only dry run that lists the cards it
 * would export. Run with `--live` once, right after MINT_LOG_SHADOW is on.
 */

const ipfsContent: MintContentPort = {
  put: async (name, bytes) =>
    (
      await ipfsFileUploader.uploadFile({
        fileName: name,
        fileBuffer: bytes,
        contentType: 'application/gzip'
      })
    ).cid,
  get: async () => {
    throw new Error('The genesis run only writes files');
  }
};

export async function main(args = process.argv.slice(2)): Promise<void> {
  if (args.includes('--help')) {
    process.stdout.write(
      'mint-log:genesis [--live]\nDefaults to a read-only dry run that lists the cards. --live writes the files to IPFS and appends the genesis entry.\n'
    );
    return;
  }
  const unknown = args.filter((arg) => arg !== '--live');
  if (unknown.length) throw new Error('Invalid arguments; use --help');
  const live = args.includes('--live');
  const { doInDbContext } = await import('@/secrets');
  const { dbSupplier } = await import('@/sql-executor');
  const output = await doInDbContext(
    async () => {
      if (!live) {
        const cards = await dbSupplier().executeNativeQueriesInTransaction(
          (connection) => mintGenesisReader.cards(connection)
        );
        return { live: false, cards: cards.length };
      }
      const log = getMintLogPorts().log;
      if (!log) {
        throw new Error(
          'No record log is bound: deploy the signed-records module first'
        );
      }
      const entry = await runMintGenesis({ content: ipfsContent, log });
      return {
        live: true,
        seq: entry.seq,
        cards: (entry.inputs.cards as unknown[]).length,
        distribution_cursor_block: entry.inputs.distribution_cursor_block
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
