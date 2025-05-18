import { when } from 'jest-when';
import { Time } from '../time';
import { redisCached, initRedis } from '../redis';

const mockClient = {
  get: jest.fn(),
  set: jest.fn(),
  on: jest.fn(),
  connect: jest.fn(),
  mGet: jest.fn(),
  del: jest.fn(),
  keys: jest.fn()
};
const createClient = jest.fn(() => mockClient);

jest.mock('redis', () => ({ createClient }));

describe('redisCached', () => {
  beforeAll(async () => {
    await initRedis();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('writes with EX when unit=seconds', async () => {
    when(mockClient.get).calledWith('a').mockResolvedValue(null);
    const cb = jest.fn().mockResolvedValue('value');
    await redisCached('a', Time.seconds(123), 'seconds', cb);
    expect(mockClient.set).toHaveBeenCalledWith(
      'a',
      JSON.stringify('value'),
      { EX: 123 }
    );
  });

  it('writes with PX when unit=milliseconds', async () => {
    when(mockClient.get).calledWith('b').mockResolvedValue(null);
    const cb = jest.fn().mockResolvedValue('value');
    await redisCached('b', Time.millis(123), 'milliseconds', cb);
    expect(mockClient.set).toHaveBeenCalledWith(
      'b',
      JSON.stringify('value'),
      { PX: 123 }
    );
  });

  it('returns cached falsy value', async () => {
    when(mockClient.get).calledWith('zero').mockResolvedValue('0');
    const cb = jest.fn();
    const result = await redisCached('zero', Time.seconds(1), 'seconds', cb);
    expect(result).toBe(0);
    expect(cb).not.toHaveBeenCalled();
    expect(mockClient.set).not.toHaveBeenCalled();
  });

  it('evicts and recovers from corrupt JSON', async () => {
    when(mockClient.get).calledWith('bad').mockResolvedValue('{');
    const cbPayload = { ok: true };
    const cb = jest.fn().mockResolvedValue(cbPayload);
    const ttl = Time.seconds(2);

    const result = await redisCached('bad', ttl, 'seconds', cb);

    expect(result).toEqual(cbPayload);
    expect(mockClient.del).toHaveBeenCalledWith('bad');
    expect(mockClient.set).toHaveBeenCalledWith(
      'bad',
      JSON.stringify(cbPayload),
      { EX: Math.ceil(ttl.toSeconds()) }
    );
  });
});
