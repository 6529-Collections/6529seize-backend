import {
  SUBSCRIPTIONS_BALANCES_TABLE,
  SUBSCRIPTIONS_ID_BALANCES_TABLE,
  SUBSCRIPTIONS_ID_LOGS_TABLE,
  SUBSCRIPTIONS_ID_MODE_TABLE,
  SUBSCRIPTIONS_ID_NFTS_FINAL_TABLE,
  SUBSCRIPTIONS_ID_NFTS_FINAL_UPLOAD_TABLE,
  SUBSCRIPTIONS_ID_NFTS_TABLE,
  SUBSCRIPTIONS_ID_REDEEMED_TABLE,
  SUBSCRIPTIONS_ID_TOP_UP_TABLE,
  SUBSCRIPTIONS_LOGS_TABLE,
  SUBSCRIPTIONS_MODE_TABLE,
  SUBSCRIPTIONS_NFTS_FINAL_TABLE,
  SUBSCRIPTIONS_NFTS_FINAL_UPLOAD_TABLE,
  SUBSCRIPTIONS_NFTS_TABLE,
  SUBSCRIPTIONS_REDEEMED_TABLE,
  SUBSCRIPTIONS_TOP_UP_TABLE
} from '@/constants';
import { CustomApiCompliantException } from '@/exceptions';
import { walletsOfKey } from '../opening/opening-attribution';
import {
  IdentityDirectory,
  isPrincipalId,
  mirrorIdentityDirectory
} from './identity-directory';
import {
  SubscriptionsIdentitySwitch,
  subscriptionsIdentitySwitch
} from './identity-switch';

/** The subscription tables a reader uses, and the column they key rows by. */
export interface SubscriptionTables {
  readonly identity: boolean;
  readonly key: 'consolidation_key' | 'identity_key';
  readonly balances: string;
  readonly mode: string;
  readonly nfts: string;
  readonly final: string;
  readonly upload: string;
  readonly logs: string;
  readonly redeemed: string;
  readonly topUp: string;
}

export const LEGACY_SUBSCRIPTION_TABLES: SubscriptionTables = {
  identity: false,
  key: 'consolidation_key',
  balances: SUBSCRIPTIONS_BALANCES_TABLE,
  mode: SUBSCRIPTIONS_MODE_TABLE,
  nfts: SUBSCRIPTIONS_NFTS_TABLE,
  final: SUBSCRIPTIONS_NFTS_FINAL_TABLE,
  upload: SUBSCRIPTIONS_NFTS_FINAL_UPLOAD_TABLE,
  logs: SUBSCRIPTIONS_LOGS_TABLE,
  redeemed: SUBSCRIPTIONS_REDEEMED_TABLE,
  topUp: SUBSCRIPTIONS_TOP_UP_TABLE
};

export const IDENTITY_SUBSCRIPTION_TABLES: SubscriptionTables = {
  identity: true,
  key: 'identity_key',
  balances: SUBSCRIPTIONS_ID_BALANCES_TABLE,
  mode: SUBSCRIPTIONS_ID_MODE_TABLE,
  nfts: SUBSCRIPTIONS_ID_NFTS_TABLE,
  final: SUBSCRIPTIONS_ID_NFTS_FINAL_TABLE,
  upload: SUBSCRIPTIONS_ID_NFTS_FINAL_UPLOAD_TABLE,
  logs: SUBSCRIPTIONS_ID_LOGS_TABLE,
  redeemed: SUBSCRIPTIONS_ID_REDEEMED_TABLE,
  topUp: SUBSCRIPTIONS_ID_TOP_UP_TABLE
};

/** The tables that are the truth now (re-read at least every 60 s). */
export async function subscriptionTables(
  identitySwitch: SubscriptionsIdentitySwitch = subscriptionsIdentitySwitch
): Promise<SubscriptionTables> {
  return (await identitySwitch.identityTablesAreTruth())
    ? IDENTITY_SUBSCRIPTION_TABLES
    : LEGACY_SUBSCRIPTION_TABLES;
}

/** What a route's key reads by. */
export interface SubscriptionReadScope {
  readonly tables: SubscriptionTables;
  /** The value to match in `tables.key`. */
  readonly key: string;
  /** The consolidation key eligibility and the airdrop rule read by. */
  readonly consolidationKey: string;
}

/**
 * The identity a route's key names: a principal id as it is; a wallet or a
 * consolidation key through its wallets' identity. A key whose wallets now
 * belong to more than one identity is refused with 409.
 */
export async function identityOfRouteKey(
  routeKey: string,
  directory: IdentityDirectory = mirrorIdentityDirectory
): Promise<string> {
  const key = routeKey.toLowerCase();
  if (isPrincipalId(key)) {
    return key;
  }
  const identities = new Set(
    (await directory.identitiesOf(walletsOfKey(key))).values()
  );
  if (identities.size !== 1) {
    throw new CustomApiCompliantException(
      409,
      'The wallets of this key now belong to more than one identity; use one wallet or the identity.'
    );
  }
  return Array.from(identities)[0];
}

/**
 * Resolves a route's key against the tables that are the truth. Before the
 * identity switch nothing changes: the legacy tables, matched by the key as
 * given.
 */
export async function subscriptionReadScope(
  routeKey: string,
  options: {
    readonly directory?: IdentityDirectory;
    readonly identitySwitch?: SubscriptionsIdentitySwitch;
  } = {}
): Promise<SubscriptionReadScope> {
  const tables = await subscriptionTables(options.identitySwitch);
  if (!tables.identity) {
    return { tables, key: routeKey, consolidationKey: routeKey };
  }
  const directory = options.directory ?? mirrorIdentityDirectory;
  const identityKey = await identityOfRouteKey(routeKey, directory);
  const consolidationKey = isPrincipalId(routeKey)
    ? ((await directory.consolidationKeysOf([identityKey])).get(identityKey) ??
      identityKey)
    : routeKey.toLowerCase();
  return { tables, key: identityKey, consolidationKey };
}
