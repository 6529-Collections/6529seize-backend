import { canonicalAnswer, parsePath } from '@/rebuild/probes/canonical';
import { notifyManifest } from './notify.manifest';

const probe = (id: string) => {
  const found = notifyManifest.probes.find((it) => it.id === id);
  if (!found) throw new Error(`No probe ${id}`);
  return found;
};

const paths = (id: string) => (probe(id).unordered ?? []).map((it) => it.path);

describe('notify probes', () => {
  it('give every unordered path a reason, in the harness path syntax', () => {
    for (const id of ['notify.notifications', 'notify.notifications-v2']) {
      for (const { path, reason } of probe(id).unordered ?? []) {
        expect(() => parsePath(path)).not.toThrow();
        expect(reason.length).toBeGreaterThan(0);
      }
    }
  });

  it('compare follow actions as sets, two nested drops deep', () => {
    const profile = (actions: string[]) => ({ subscribed_actions: actions });
    const answer = (actions: string[]) => ({
      notifications: [
        {
          related_identity: profile(actions),
          related_drops: [
            {
              reply_to: {
                drop: {
                  parts: [
                    {
                      quoted_drop: {
                        drop: {
                          top_raters: [{ profile: profile(actions) }],
                          reactions: [{ profiles: [profile(actions)] }]
                        }
                      }
                    }
                  ]
                }
              }
            }
          ]
        }
      ]
    });
    const order = ['WAVE_CREATED', 'DROP_CREATED', 'DROP_REPLIED'];
    const other = ['DROP_REPLIED', 'WAVE_CREATED', 'DROP_CREATED'];
    const v1 = paths('notify.notifications');
    expect(canonicalAnswer(answer(order), [], v1)).toBe(
      canonicalAnswer(answer(other), [], v1)
    );
    // Without the paths the two orders differ, so the test can fail.
    expect(canonicalAnswer(answer(order))).not.toBe(
      canonicalAnswer(answer(other))
    );
  });

  it("compare a v2 wave creator's follow actions as sets", () => {
    const answer = (actions: string[]) => ({
      notifications: [
        {
          related_wave: {
            creator: { subscribed_actions: actions },
            parent_wave: { creator: { subscribed_actions: actions } }
          },
          related_drops: [
            { wave: { creator: { subscribed_actions: actions } } }
          ]
        }
      ]
    });
    const v2 = paths('notify.notifications-v2');
    expect(canonicalAnswer(answer(['A', 'B']), [], v2)).toBe(
      canonicalAnswer(answer(['B', 'A']), [], v2)
    );
    // Without the paths the two orders differ, so the test can fail.
    expect(canonicalAnswer(answer(['A', 'B']))).not.toBe(
      canonicalAnswer(answer(['B', 'A']))
    );
  });
});
