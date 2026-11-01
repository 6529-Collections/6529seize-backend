import * as fc from 'fast-check';
import { ProfileDirectMessagePolicy } from '@/entities/IProfilePreferences';
import { CustomApiCompliantException } from '@/exceptions';
import {
  decideDirectMessageAdmission,
  DirectMessageAdmission,
  DirectMessageAdmissionFacts,
  directMessageAdmissionError,
  DirectMessageRefusalReason
} from './direct-message-admission';

const SENDER = 'sender-profile';

function facts(
  overrides: Partial<DirectMessageAdmissionFacts> = {}
): DirectMessageAdmissionFacts {
  return {
    recipientProfileId: 'recipient-profile',
    recipientHandle: 'recipient',
    policy: ProfileDirectMessagePolicy.EVERYONE,
    allowPeopleIFollow: true,
    recipientFollowsSender: false,
    recipientBlockedSender: false,
    senderBlockedRecipient: false,
    group: { status: 'NOT_USED' },
    ...overrides
  };
}

function groupFacts(
  overrides: Partial<DirectMessageAdmissionFacts> & {
    readonly member?: boolean;
    readonly publicGroup?: { id: string; name: string } | null;
  } = {}
): DirectMessageAdmissionFacts {
  const { member = false, publicGroup = null, ...rest } = overrides;
  return facts({
    policy: ProfileDirectMessagePolicy.GROUP_MEMBERS,
    group: { status: 'AVAILABLE', senderIsMember: member, publicGroup },
    ...rest
  });
}

function reasonOf(decision: DirectMessageAdmission) {
  return decision.allowed ? 'ALLOWED' : decision.reason;
}

describe('decideDirectMessageAdmission', () => {
  it.each([
    ['anyone', facts(), 'ALLOWED'],
    [
      'people I follow, followed sender',
      facts({
        policy: ProfileDirectMessagePolicy.PEOPLE_I_FOLLOW,
        recipientFollowsSender: true
      }),
      'ALLOWED'
    ],
    [
      'people I follow, unfollowed sender',
      facts({ policy: ProfileDirectMessagePolicy.PEOPLE_I_FOLLOW }),
      DirectMessageRefusalReason.PEOPLE_I_FOLLOW_ONLY
    ],
    [
      'nobody, even a followed sender',
      facts({
        policy: ProfileDirectMessagePolicy.NOBODY,
        recipientFollowsSender: true
      }),
      DirectMessageRefusalReason.NOT_ACCEPTING
    ],
    ['group member', groupFacts({ member: true }), 'ALLOWED'],
    [
      'group non-member',
      groupFacts({ member: false }),
      DirectMessageRefusalReason.GROUP_MEMBERS_ONLY
    ],
    [
      'group non-member the recipient follows (bypass on)',
      groupFacts({ recipientFollowsSender: true, allowPeopleIFollow: true }),
      'ALLOWED'
    ],
    [
      'group non-member the recipient follows (bypass off)',
      groupFacts({ recipientFollowsSender: true, allowPeopleIFollow: false }),
      DirectMessageRefusalReason.GROUP_MEMBERS_ONLY
    ],
    [
      'group member with the follow bypass off',
      groupFacts({ member: true, allowPeopleIFollow: false }),
      'ALLOWED'
    ]
  ])('%s -> %s', (_name, input, expected) => {
    expect(reasonOf(decideDirectMessageAdmission(SENDER, input))).toBe(
      expected
    );
  });

  describe('missing or hidden group fails closed to people I follow', () => {
    it('refuses an unfollowed sender with the people-I-follow reason', () => {
      expect(
        reasonOf(
          decideDirectMessageAdmission(
            SENDER,
            facts({
              policy: ProfileDirectMessagePolicy.GROUP_MEMBERS,
              group: { status: 'UNAVAILABLE' }
            })
          )
        )
      ).toBe(DirectMessageRefusalReason.PEOPLE_I_FOLLOW_ONLY);
    });

    it('admits a followed sender even when the follow bypass is off', () => {
      expect(
        reasonOf(
          decideDirectMessageAdmission(
            SENDER,
            facts({
              policy: ProfileDirectMessagePolicy.GROUP_MEMBERS,
              group: { status: 'UNAVAILABLE' },
              recipientFollowsSender: true,
              allowPeopleIFollow: false
            })
          )
        )
      ).toBe('ALLOWED');
    });
  });

  describe('blocks always win', () => {
    it.each([
      ['anyone', facts()],
      [
        'people I follow (followed)',
        facts({
          policy: ProfileDirectMessagePolicy.PEOPLE_I_FOLLOW,
          recipientFollowsSender: true
        })
      ],
      ['group member', groupFacts({ member: true })],
      [
        'followed group bypass',
        groupFacts({ recipientFollowsSender: true, allowPeopleIFollow: true })
      ]
    ])(
      'a recipient block refuses with the generic reason under %s',
      (_name, input) => {
        const decision = decideDirectMessageAdmission(SENDER, {
          ...input,
          recipientBlockedSender: true
        });
        expect(reasonOf(decision)).toBe(
          DirectMessageRefusalReason.NOT_ACCEPTING
        );
      }
    );

    it('tells a sender about their own block, whatever the recipient did', () => {
      for (const recipientBlockedSender of [false, true]) {
        expect(
          reasonOf(
            decideDirectMessageAdmission(
              SENDER,
              facts({ senderBlockedRecipient: true, recipientBlockedSender })
            )
          )
        ).toBe(DirectMessageRefusalReason.SENDER_BLOCKED_RECIPIENT);
      }
    });

    it('is never admitted while either profile blocks the other (property)', () => {
      fc.assert(
        fc.property(
          fc.constantFrom(...Object.values(ProfileDirectMessagePolicy)),
          fc.boolean(),
          fc.boolean(),
          fc.boolean(),
          fc.boolean(),
          fc.boolean(),
          (
            policy,
            follows,
            bypass,
            member,
            recipientBlockedSender,
            senderBlockedRecipient
          ) => {
            fc.pre(recipientBlockedSender || senderBlockedRecipient);
            const decision = decideDirectMessageAdmission(SENDER, {
              ...groupFacts({ member }),
              policy,
              recipientFollowsSender: follows,
              allowPeopleIFollow: bypass,
              recipientBlockedSender,
              senderBlockedRecipient
            });
            expect(decision.allowed).toBe(false);
            if (!decision.allowed) {
              expect([
                DirectMessageRefusalReason.NOT_ACCEPTING,
                DirectMessageRefusalReason.SENDER_BLOCKED_RECIPIENT
              ]).toContain(decision.reason);
            }
          }
        )
      );
    });
  });

  it('fails closed for an unknown stored policy', () => {
    expect(
      reasonOf(
        decideDirectMessageAdmission(
          SENDER,
          facts({ policy: 'SOMETHING_NEW' as ProfileDirectMessagePolicy })
        )
      )
    ).toBe(DirectMessageRefusalReason.NOT_ACCEPTING);
  });

  it('always admits the sender to their own conversation', () => {
    expect(
      decideDirectMessageAdmission(
        SENDER,
        facts({
          recipientProfileId: SENDER,
          policy: ProfileDirectMessagePolicy.NOBODY
        })
      ).allowed
    ).toBe(true);
  });
});

describe('directMessageAdmissionError', () => {
  function errorFor(input: DirectMessageAdmissionFacts) {
    const decision = decideDirectMessageAdmission(SENDER, input);
    if (decision.allowed) throw new Error('expected a refusal');
    return directMessageAdmissionError(decision);
  }

  it('returns a 403 with a stable code and the recipient handle', () => {
    const error = errorFor(
      facts({ policy: ProfileDirectMessagePolicy.PEOPLE_I_FOLLOW })
    );
    expect(error).toBeInstanceOf(CustomApiCompliantException);
    expect(error.getStatusCode()).toBe(403);
    expect(error.code).toBe('DM_RECIPIENT_PEOPLE_I_FOLLOW_ONLY');
    expect(error.details).toEqual({ handle: 'recipient' });
    expect(error.message).toBe(
      "You can't start a new direct message with @recipient because they only accept messages from people they follow."
    );
  });

  it('keeps the existing nobody copy', () => {
    expect(
      errorFor(facts({ policy: ProfileDirectMessagePolicy.NOBODY })).message
    ).toBe(
      "You can't start a new direct message with @recipient because they don't accept new direct messages."
    );
  });

  it('names a public group but never a private one', () => {
    const publicError = errorFor(
      groupFacts({ publicGroup: { id: 'group-1', name: 'Meme holders' } })
    );
    expect(publicError.code).toBe('DM_RECIPIENT_GROUP_MEMBERS_ONLY');
    expect(publicError.details).toEqual({
      handle: 'recipient',
      group_id: 'group-1',
      group_name: 'Meme holders'
    });
    expect(publicError.message).toContain('"Meme holders"');

    const privateError = errorFor(groupFacts({ publicGroup: null }));
    expect(privateError.details).toEqual({ handle: 'recipient' });
    expect(privateError.message).toContain('members of a group they chose');
  });

  it('makes a recipient block indistinguishable from "nobody"', () => {
    const blocked = errorFor(facts({ recipientBlockedSender: true }));
    const nobody = errorFor(
      facts({ policy: ProfileDirectMessagePolicy.NOBODY })
    );
    expect(blocked.code).toBe(nobody.code);
    expect(blocked.message).toBe(nobody.message);
    expect(blocked.details).toEqual(nobody.details);
    expect(JSON.stringify(blocked.details)).not.toMatch(/block/i);
    expect(blocked.message).not.toMatch(/block/i);
  });

  it('explains the sender block to the sender', () => {
    const error = errorFor(facts({ senderBlockedRecipient: true }));
    expect(error.code).toBe('DM_SENDER_BLOCKED_RECIPIENT');
    expect(error.message).toContain('you have blocked them');
  });
});
