import { TypedDataEncoder, Wallet } from 'ethers';
import {
  TEST_BOT_DEVICE_KEY,
  TEST_BOT_DEVICE_SEED,
  TEST_BOT_WALLET,
  TEST_BOT_WALLET_KEY
} from '@/tests/fixtures/bot-device-signing.fixture';
import {
  APP_DEVICE_GRANT_DOMAIN_V2,
  APP_DEVICE_GRANT_TYPES_V2,
  buildAppDeviceGrantMessage,
  computeAppDeviceGrantId,
  serializeAppDeviceGrantMessage
} from './app-device-grant';
import { BotDeviceGrantCliIo, main } from './bot-device-grant.cli';
import {
  botDeviceGrantTypedData,
  buildBotDeviceGrant,
  ed25519PrivateKeyFromSeed,
  ed25519PublicKeyOf,
  newEd25519Seed
} from './bot-device-grant';
import { parseBotDeviceKeys } from './bot-device-signer';

// Shared app grant v2 vectors (app-device-grant-v2.test.ts, the frontend and
// wave-events web_vectors.rs): the test wallet's signing-only grant of the
// DN1 device key, issued 1792324800 for 6529 Desktop.
const ISSUED_AT = new Date(1_792_324_800_000);
const SIGNING_GRANT_ID_V2 =
  '0x9c049140e722cb25940749c8b9ba5167b4fa79c56d97aad08a3fa8bf9d98d29f';
const SIGNING_SIGNATURE_V2 =
  '0xd63015f9778f55b14b90f9aefc091394a5e2a5c2e934d1f3d14ab0a029ea86390f299641867af17663b26ce4d367e2265ce78f1e226dd1edfce984fd6d34b2eb1c';
// The stored message as wave-events' AppGrant::message_text renders it.
const STORED_MESSAGE_V2 =
  '{"statement":"Turn on signed messages on this device until 16 Apr 2027. This device will sign your posts, edits, deletes and reactions so anyone can verify they came from your wallet. It can\'t move funds, change your handle, add devices or act as an admin. No transaction, no gas, no token approvals. (Device key d75a9801...f707511a)","wallet":"0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266","deviceKey":"0xd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a","scopes":"post,edit,delete,react","mlsDeviceKey":"0x0000000000000000000000000000000000000000000000000000000000000000","ciphersuites":[],"issuedAt":1792324800,"expiresAt":1807876800,"origin":"6529 Desktop"}';

describe('bot device grant', () => {
  it('builds the shared signing-only v2 grant', async () => {
    const message = buildAppDeviceGrantMessage(
      buildBotDeviceGrant({
        wallet: TEST_BOT_WALLET,
        deviceKey: TEST_BOT_DEVICE_KEY,
        issuedAt: ISSUED_AT,
        origin: '6529 Desktop'
      })
    );
    expect(computeAppDeviceGrantId(message)).toBe(SIGNING_GRANT_ID_V2);
    expect(serializeAppDeviceGrantMessage(message)).toBe(STORED_MESSAGE_V2);
    await expect(
      new Wallet(TEST_BOT_WALLET_KEY).signTypedData(
        APP_DEVICE_GRANT_DOMAIN_V2,
        APP_DEVICE_GRANT_TYPES_V2,
        message
      )
    ).resolves.toBe(SIGNING_SIGNATURE_V2);
  });

  it('defaults to 6529.io and 180 days', () => {
    const grant = buildBotDeviceGrant({
      wallet: TEST_BOT_WALLET.toUpperCase().replace('0X', '0x'),
      deviceKey: TEST_BOT_DEVICE_KEY,
      issuedAt: new Date(1_792_324_812_345)
    });
    expect(grant).toMatchObject({
      wallet: TEST_BOT_WALLET,
      origin: '6529.io',
      scopes: ['post', 'edit', 'delete', 'react'],
      issued_at: 1_792_324_812,
      expires_at: 1_807_876_800
    });
  });

  it('prints typed data any wallet signs to the same grant id', () => {
    const message = buildAppDeviceGrantMessage(
      buildBotDeviceGrant({
        wallet: TEST_BOT_WALLET,
        deviceKey: TEST_BOT_DEVICE_KEY,
        issuedAt: ISSUED_AT,
        origin: '6529 Desktop'
      })
    );
    const payload = JSON.parse(
      JSON.stringify(botDeviceGrantTypedData(message))
    );
    const { EIP712Domain: _domain, ...types } = payload.types;
    expect(payload.primaryType).toBe('DeviceGrant');
    expect(
      TypedDataEncoder.hash(
        payload.domain,
        types,
        payload.message
      ).toLowerCase()
    ).toBe(SIGNING_GRANT_ID_V2);
  });

  it('derives Ed25519 keys from seeds', () => {
    expect(
      ed25519PublicKeyOf(ed25519PrivateKeyFromSeed(TEST_BOT_DEVICE_SEED))
    ).toBe(TEST_BOT_DEVICE_KEY);
    const seed = newEd25519Seed();
    expect(seed).toMatch(/^0x[0-9a-f]{64}$/);
    expect(ed25519PublicKeyOf(ed25519PrivateKeyFromSeed(seed))).toMatch(
      /^0x[0-9a-f]{64}$/
    );
    expect(() => ed25519PrivateKeyFromSeed('0x12')).toThrow();
  });
});

describe('waves:bot-device-grant', () => {
  const NOW = new Date(1_792_324_812_345);

  function io(
    overrides: Partial<BotDeviceGrantCliIo> = {}
  ): BotDeviceGrantCliIo & { output: string[]; messages: string[] } {
    const output: string[] = [];
    const messages: string[] = [];
    return {
      env: {},
      out: (text) => output.push(text),
      info: (text) => messages.push(text),
      readLine: () => Promise.reject(new Error('no input expected')),
      now: () => NOW,
      newSeed: () => TEST_BOT_DEVICE_SEED,
      ...overrides,
      output,
      messages
    };
  }

  function entryOf(output: string[]) {
    expect(output).toHaveLength(1);
    const { keys, problems } = parseBotDeviceKeys(
      output[0],
      NOW.getTime() + 60_000
    );
    expect(problems).toEqual([]);
    return { keys, raw: JSON.parse(output[0]) };
  }

  it('signs with the wallet key and prints an entry the backend accepts', async () => {
    const cli = io({ env: { BOT_WALLET_PRIVATE_KEY: TEST_BOT_WALLET_KEY } });

    await main(['--profile-id', 'bot-profile'], cli);

    const { keys, raw } = entryOf(cli.output);
    const key = keys.get('bot-profile')!;
    expect(key.grant).toMatchObject({
      wallet: TEST_BOT_WALLET,
      device_key: TEST_BOT_DEVICE_KEY,
      domain: '6529.io',
      scopes: 'post,edit,delete,react',
      expires_at: 1_807_876_800_000
    });
    expect(raw['bot-profile'].device_seed).toBe(TEST_BOT_DEVICE_SEED);
    const said = cli.messages.join('');
    expect(said).toContain(key.grant.id);
    expect(said).toContain('Expires 16 Apr 2027');
    // The wallet key never leaves the process; the seed only on stdout.
    expect(said + cli.output.join('')).not.toContain(
      TEST_BOT_WALLET_KEY.slice(2)
    );
    expect(said).not.toContain(TEST_BOT_DEVICE_SEED.slice(2));
  });

  it('takes the signature of another wallet app from standard input', async () => {
    const wallet = new Wallet(TEST_BOT_WALLET_KEY);
    const cli = io({
      readLine: async () => {
        const said = cli.messages.join('');
        const payload = JSON.parse(said.slice(said.indexOf('{')));
        const { EIP712Domain: _domain, ...types } = payload.types;
        return `${await wallet.signTypedData(payload.domain, types, payload.message)}\n`;
      }
    });

    await main(
      [
        '--profile-id',
        'bot-profile',
        '--wallet',
        TEST_BOT_WALLET,
        '--scopes',
        'post,react'
      ],
      cli
    );

    const { keys } = entryOf(cli.output);
    expect(keys.get('bot-profile')!.grant.scopes).toBe('post,react');
  });

  it.each([
    [['--wallet', TEST_BOT_WALLET], {}, /--profile-id is required/],
    [['--profile-id', 'p'], {}, /Give --wallet/],
    [
      ['--profile-id', 'p', '--wallet', `0x${'22'.repeat(20)}`],
      { BOT_WALLET_PRIVATE_KEY: TEST_BOT_WALLET_KEY },
      /is not the key of --wallet/
    ],
    [['--profile-id', 'p', '--scopes', 'react'], {}, /--scopes/],
    [['--profile-id'], {}, /Invalid arguments/],
    [['--profile-id', 'p', '--other', 'x'], {}, /Invalid arguments/]
  ])('refuses %j', async (args, env, error) => {
    const cli = io({ env });
    await expect(main(args, cli)).rejects.toThrow(error);
    expect(cli.output).toEqual([]);
  });

  it('refuses a signature that is not the wallet own', async () => {
    const cli = io({
      readLine: async () =>
        Wallet.createRandom().signTypedData(
          APP_DEVICE_GRANT_DOMAIN_V2,
          APP_DEVICE_GRANT_TYPES_V2,
          buildAppDeviceGrantMessage(
            buildBotDeviceGrant({
              wallet: TEST_BOT_WALLET,
              deviceKey: TEST_BOT_DEVICE_KEY,
              issuedAt: NOW
            })
          )
        )
    });
    await expect(
      main(['--profile-id', 'p', '--wallet', TEST_BOT_WALLET], cli)
    ).rejects.toThrow(/is not 0x[0-9a-f]{40}'s own/);
    expect(cli.output).toEqual([]);
  });

  it('prints its usage', async () => {
    const cli = io();
    await main(['--help'], cli);
    expect(cli.messages.join('')).toContain('waves:bot-device-grant');
    expect(cli.output).toEqual([]);
  });
});
