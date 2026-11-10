import fc from 'fast-check';
import { BadRequestException } from '@/exceptions';
import {
  getValidatedDirectMessageRecipientAddresses,
  MAX_DIRECT_MESSAGE_IDENTITY_ADDRESSES
} from './direct-message-wave-request';

const CREATOR = '0x1111111111111111111111111111111111111111';
const RECIPIENT = '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01';

function address(index: number): string {
  return `0x${index.toString(16).padStart(40, '0')}`;
}

describe('getValidatedDirectMessageRecipientAddresses', () => {
  it('lowercases and de-duplicates recipients case-insensitively', () => {
    expect(
      getValidatedDirectMessageRecipientAddresses(
        {
          identity_addresses: [
            RECIPIENT,
            RECIPIENT.toLowerCase(),
            RECIPIENT.toUpperCase().replace('0X', '0x')
          ]
        },
        [CREATOR]
      )
    ).toEqual([RECIPIENT.toLowerCase()]);
  });

  it('rejects the creator wallet in any casing', () => {
    expect(() =>
      getValidatedDirectMessageRecipientAddresses(
        {
          identity_addresses: [
            RECIPIENT,
            CREATOR.toUpperCase().replace('0X', '0x')
          ]
        },
        [CREATOR]
      )
    ).toThrow(new BadRequestException('You cannot DM yourself.'));
  });

  it('rejects any wallet of the creator, not only the primary one', () => {
    const consolidatedWallet = address(42);
    expect(() =>
      getValidatedDirectMessageRecipientAddresses(
        { identity_addresses: [consolidatedWallet] },
        [CREATOR, consolidatedWallet]
      )
    ).toThrow('You cannot DM yourself.');
  });

  it.each([
    ['an empty list', []],
    ['a handle instead of an address', ['punk6529']],
    ['a short address', ['0x1234']],
    ['a non-string item', [42]],
    ['an empty string', ['']]
  ])('rejects %s', (_label, identityAddresses) => {
    expect(() =>
      getValidatedDirectMessageRecipientAddresses(
        { identity_addresses: identityAddresses },
        [CREATOR]
      )
    ).toThrow(BadRequestException);
  });

  it('accepts up to the recipient cap and rejects more', () => {
    const atCap = Array.from(
      { length: MAX_DIRECT_MESSAGE_IDENTITY_ADDRESSES },
      (_, index) => address(index + 1000)
    );
    expect(
      getValidatedDirectMessageRecipientAddresses(
        { identity_addresses: atCap },
        [CREATOR]
      )
    ).toHaveLength(MAX_DIRECT_MESSAGE_IDENTITY_ADDRESSES);
    expect(() =>
      getValidatedDirectMessageRecipientAddresses(
        { identity_addresses: [...atCap, address(1)] },
        [CREATOR]
      )
    ).toThrow(BadRequestException);
  });

  it('never returns duplicates or the creator for valid inputs', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 30 }), {
          minLength: 1,
          maxLength: 40
        }),
        (indexes) => {
          const recipients = getValidatedDirectMessageRecipientAddresses(
            {
              identity_addresses: indexes.map((index) =>
                index % 2
                  ? address(index).toUpperCase().replace('0X', '0x')
                  : address(index)
              )
            },
            [CREATOR]
          );
          expect(new Set(recipients).size).toBe(recipients.length);
          expect(recipients).not.toContain(CREATOR);
          recipients.forEach((it) => expect(it).toBe(it.toLowerCase()));
        }
      )
    );
  });
});
