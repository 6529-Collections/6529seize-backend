import { RecordAnchorSource, recordAnchorService } from './record-anchor';
import {
  ChainIdentityReader,
  recordOwnerDirectory
} from './record-owner-directory';

/**
 * Wires the chain gateway client (`ChainGatewayClient`) into signed
 * records, the anchor height and the wallets' owners together: a record
 * can't be signed or checked with one and not the other. Call it once at
 * startup of the API and of each loop that verifies records; null unwires.
 */
export function wireSignedRecordsChain(
  chain: (RecordAnchorSource & ChainIdentityReader) | null
): void {
  recordAnchorService.setSource(chain);
  recordOwnerDirectory.setChain(chain);
}
