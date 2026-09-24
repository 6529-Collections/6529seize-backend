import { Wallet } from 'ethers';
import { NewsletterMaterial } from './newsletter-collector';
import { publishNewsletter } from './newsletter.service';

const config = {
  waveId: 'destination',
  wallet: new Wallet('0x' + '12'.repeat(32)),
  modelId: 'test-model'
};
const window = {
  start: Date.parse('2026-09-23T00:00:00Z'),
  end: Date.parse('2026-09-24T00:00:00Z'),
  scheduled: true
};
const material: NewsletterMaterial = {
  window: {
    start: new Date(window.start).toISOString(),
    end: new Date(window.end).toISOString()
  },
  sources: [],
  winners: [],
  mints: [
    {
      collection: 'The Memes',
      card: 552,
      title: 'Test card',
      url: 'https://6529.io/the-memes/552',
      artists: [],
      first_mint: null,
      first_mint_in_window: new Date(window.start).toISOString(),
      minted_count: 1
    }
  ]
};

function dependencies() {
  return {
    db: { publishedEdition: jest.fn().mockResolvedValue(null) },
    collector: { collect: jest.fn().mockResolvedValue(material) },
    writer: { write: jest.fn().mockResolvedValue('A linked newsletter.') },
    publisher: {
      authorId: jest.fn().mockResolvedValue('publisher'),
      publish: jest.fn().mockResolvedValue('new-drop')
    }
  };
}

describe('newsletter publication', () => {
  it('skips a committed scheduled edition before collection or generation', async () => {
    const deps = dependencies();
    deps.db.publishedEdition.mockResolvedValue('existing');
    expect(await publishNewsletter(config, window, {}, deps)).toEqual({
      status: 'already-published',
      dropId: 'existing'
    });
    expect(deps.db.publishedEdition).toHaveBeenCalledWith(
      'daily:2026-09-23',
      'destination',
      'publisher',
      {}
    );
    expect(deps.collector.collect).not.toHaveBeenCalled();
    expect(deps.writer.write).not.toHaveBeenCalled();
    expect(deps.publisher.publish).not.toHaveBeenCalled();
  });

  it('always publishes a fresh edition for manual invocations, even after a daily edition', async () => {
    const deps = dependencies();
    deps.db.publishedEdition.mockResolvedValue('existing');
    const manual = { ...window, scheduled: false };
    await publishNewsletter(config, manual, {}, deps);
    await publishNewsletter(config, manual, {}, deps);
    expect(deps.db.publishedEdition).not.toHaveBeenCalled();
    expect(deps.publisher.publish).toHaveBeenCalledTimes(2);
    const ids = deps.publisher.publish.mock.calls.map((call) => call[1]);
    expect(ids[0]).toMatch(/^manual:/);
    expect(ids[0]).not.toBe(ids[1]);
    expect(deps.collector.collect).toHaveBeenCalledWith(
      manual,
      'destination',
      'publisher',
      {}
    );
  });

  it('does not publish when there is no activity or generation fails', async () => {
    const deps = dependencies();
    deps.collector.collect.mockResolvedValueOnce({ ...material, mints: [] });
    expect(await publishNewsletter(config, window, {}, deps)).toEqual({
      status: 'no-public-activity'
    });
    deps.writer.write.mockRejectedValue(new Error('model timed out'));
    await expect(publishNewsletter(config, window, {}, deps)).rejects.toThrow(
      'model timed out'
    );
    expect(deps.publisher.publish).not.toHaveBeenCalled();
  });
});
