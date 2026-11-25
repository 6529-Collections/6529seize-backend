import * as path from 'node:path';
import { parseSourceArg } from '@/rebuild/sources/source-spec';
import { fillSourcePlaceholders } from '@/rebuild/run/runner';

describe('source specs', () => {
  it('reads every form', () => {
    expect(parseSourceArg('gateway=http://127.0.0.1:7000')).toEqual([
      'gateway',
      { kind: 'live', url: 'http://127.0.0.1:7000' }
    ]);
    expect(parseSourceArg('gateway=replay:rec/gw')).toEqual([
      'gateway',
      { kind: 'replay', dir: path.resolve('rec/gw') }
    ]);
    expect(
      parseSourceArg('ethereum=record:rec/eth@http://127.0.0.1:8545')
    ).toEqual([
      'ethereum',
      {
        kind: 'record',
        dir: path.resolve('rec/eth'),
        upstream: 'http://127.0.0.1:8545'
      }
    ]);
    expect(parseSourceArg('ethereum=anvil')[1]).toEqual({
      kind: 'anvil',
      state: null
    });
    expect(parseSourceArg('ethereum=anvil:w1.json')[1]).toEqual({
      kind: 'anvil',
      state: path.resolve('w1.json')
    });
    expect(parseSourceArg('relays=relay')[1]).toEqual({
      kind: 'relay',
      dir: null
    });
    expect(parseSourceArg('relays=wss://relay.example.test')[1]).toEqual({
      kind: 'live',
      url: 'wss://relay.example.test'
    });
    expect(parseSourceArg('files=world/files')[1]).toEqual({
      kind: 'files',
      dir: path.resolve('world/files')
    });
  });

  it('refuses sources a name can not have', () => {
    expect(() => parseSourceArg('chain=x')).toThrow('name one of');
    expect(() => parseSourceArg('gateway=anvil')).toThrow();
    expect(() => parseSourceArg('relays=replay:x')).toThrow(
      "relays can't be replay"
    );
    expect(() => parseSourceArg('files=relay')).toThrow("files can't be relay");
    expect(() => parseSourceArg('gateway=record:dir')).toThrow('record needs');
  });

  it('fills source placeholders in flag values', () => {
    expect(
      fillSourcePlaceholders('{relays},{relays}', {
        relays: 'ws://127.0.0.1:1'
      })
    ).toBe('ws://127.0.0.1:1,ws://127.0.0.1:1');
    expect(fillSourcePlaceholders('{gateway}/v1', { gateway: null })).toBe(
      '{gateway}/v1'
    );
  });
});
