import {
  E2EE_MODERATION_INBOX,
  isSealedE2eeRecordContent,
  openE2eeRecordContent,
  parseE2eeModerationKey,
  sealE2eeRecordContent,
  sealedE2eeRecordRecipient
} from '@/e2ee/relay/e2ee-moderation-seal';
import {
  decodeE2eeRecordContent,
  encodeE2eeRecordContent
} from '@/e2ee/relay/e2ee-record-container';
import { parseE2eeFamilyWave } from '@/e2ee/relay/e2ee-record-event';
import {
  e2eeRelayMode,
  readE2eeRelaySettings
} from '@/e2ee/relay/e2ee-relay-config';
import { E2eeStreamPublisher } from '@/e2ee/relay/e2ee-stream-publisher';
import {
  e2eeTestModerationKey,
  e2eeTestRelayIdentity
} from '@/tests/fixtures/e2ee-stream-store.fixture';

const WAVE = `md/${E2EE_MODERATION_INBOX}`;
const ORDERER = e2eeTestRelayIdentity(7, `0x${'aa'.repeat(20)}`);
const MODERATION = e2eeTestModerationKey(0x31);
const OTHER = e2eeTestModerationKey(0x32, 'mod-other');

function content(notes: string) {
  return encodeE2eeRecordContent({
    type: 'report',
    pos: 1,
    prev: null,
    ops: [
      {
        op: 'put',
        table: 'e2ee_reports',
        row: { id: '0x01', notes, body: Buffer.from('reported message') }
      }
    ]
  }).content;
}

function seal(bytes: Buffer, wave = WAVE) {
  return sealE2eeRecordContent({
    content: bytes,
    wave,
    from: ORDERER.deviceKey,
    to: MODERATION.recipient
  });
}

describe('report records sealed to the moderation service key', () => {
  it('names a well-formed md stream', () => {
    expect(parseE2eeFamilyWave(WAVE)).toEqual({
      family: 'md',
      owner: E2EE_MODERATION_INBOX
    });
  });

  it('opens with the moderation key and shows nothing in the clear', () => {
    const plain = content('spam from a stranger');
    const sealed = seal(plain);
    expect(isSealedE2eeRecordContent(sealed)).toBe(true);
    expect(isSealedE2eeRecordContent(plain)).toBe(false);
    expect(sealedE2eeRecordRecipient(sealed)).toBe('svc:mod-test');
    expect(sealed.includes(Buffer.from('spam from a stranger'))).toBe(false);
    expect(sealed.includes(Buffer.from('reported message'))).toBe(false);
    const opened = openE2eeRecordContent({
      bytes: sealed,
      wave: WAVE,
      keys: [...OTHER.keys, ...MODERATION.keys]
    });
    expect(opened.equals(plain)).toBe(true);
    expect(decodeE2eeRecordContent(opened).ops[0]).toMatchObject({
      table: 'e2ee_reports',
      row: { notes: 'spam from a stranger' }
    });
    // A fresh key and nonce every time.
    expect(seal(plain).equals(sealed)).toBe(false);
  });

  it('refuses another key, another stream, and altered bytes', () => {
    const sealed = seal(content('n'));
    expect(() =>
      openE2eeRecordContent({ bytes: sealed, wave: WAVE, keys: OTHER.keys })
    ).toThrow('a key this reader does not hold');
    expect(() =>
      openE2eeRecordContent({
        bytes: sealed,
        wave: 'md/0x0d',
        keys: MODERATION.keys
      })
    ).toThrow('does not open');
    const altered = Buffer.from(sealed);
    altered[altered.length - 20] ^= 1;
    expect(() =>
      openE2eeRecordContent({
        bytes: altered,
        wave: WAVE,
        keys: MODERATION.keys
      })
    ).toThrow('does not open');
    expect(() =>
      openE2eeRecordContent({
        bytes: sealed.subarray(0, 40),
        wave: WAVE,
        keys: MODERATION.keys
      })
    ).toThrow('cut short');
  });

  it('reads the moderation key settings', () => {
    const publicKey = `0x${MODERATION.recipient.publicKey.toString('hex')}`;
    expect(
      parseE2eeModerationKey(
        JSON.stringify({ id: 'mod-test', public_key: publicKey })
      )
    ).toEqual(MODERATION.recipient);
    expect(() =>
      parseE2eeModerationKey(JSON.stringify({ id: 'Mod', public_key: '0x' }))
    ).toThrow('must be {"id","public_key"}');
    const base = {
      E2EE_RELAY_MODE: 'mirror',
      E2EE_RELAY_URLS: 'wss://relay.test',
      E2EE_RELAY_NET: 'net',
      E2EE_ORDERER_KEY: ORDERER.seed.toString('hex'),
      E2EE_ORDERER_GRANT: JSON.stringify(ORDERER.grant)
    };
    expect(() => readE2eeRelaySettings(base)).toThrow(
      'E2EE_MODERATION_PUBLIC_KEY is missing'
    );
    const moderationEnv = {
      E2EE_MODERATION_PUBLIC_KEY: JSON.stringify({
        id: 'mod-test',
        public_key: publicKey
      })
    };
    const settings = readE2eeRelaySettings({ ...base, ...moderationEnv });
    expect(settings.moderation).toEqual(MODERATION.recipient);
    expect(settings.moderationKeys).toEqual([]);
    const privateKey = `0x${MODERATION.keys[0].privateKey.toString('hex')}`;
    expect(
      readE2eeRelaySettings({
        E2EE_RELAY_MODE: 'off',
        ...moderationEnv,
        E2EE_MODERATION_KEYS: JSON.stringify([
          { id: 'mod-test', private_key: privateKey }
        ])
      }).moderationKeys
    ).toEqual(MODERATION.keys);
    expect(() =>
      readE2eeRelaySettings({
        ...base,
        ...moderationEnv,
        E2EE_MODERATION_KEYS: JSON.stringify([
          {
            id: 'mod-test',
            private_key: `0x${OTHER.keys[0].privateKey.toString('hex')}`
          }
        ])
      })
    ).toThrow('holds another key for mod-test');
  });

  it('takes primary only with its opt-in, and reads the mode alone', () => {
    expect(e2eeRelayMode({ E2EE_RELAY_MODE: 'primary' })).toBe('mirror');
    expect(
      e2eeRelayMode({
        E2EE_RELAY_MODE: 'primary',
        E2EE_RELAY_PRIMARY_OPT_IN: 'true'
      })
    ).toBe('primary');
    expect(e2eeRelayMode({ E2EE_RELAY_MODE: 'mirror' })).toBe('mirror');
    expect(e2eeRelayMode({})).toBe('off');
    // Off never parses a key setting, so a bad one cannot break writes.
    const publisher = new E2eeStreamPublisher({
      settings: () => {
        throw new Error('E2EE_MODERATION_KEYS is not JSON');
      },
      mode: () => 'off',
      store: {} as never,
      pool: () => {
        throw new Error('no pool');
      },
      anchors: { anchor: async () => 1 },
      now: () => 1
    });
    expect(publisher.batch()).toBeNull();
  });
});
