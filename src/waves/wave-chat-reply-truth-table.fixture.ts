/**
 * Test fixture: whether a profile may reply in a wave chat, written out for
 * every combination of the inputs that decide it. Drop creation and the help
 * bot trigger are both tested against this table so they cannot drift apart.
 */
export interface WaveChatReplyTruthTableRow {
  readonly chat_enabled: boolean;
  readonly chat_group_id: string | null;
  readonly chat_replies_open: boolean;
  readonly inChatGroup: boolean;
  readonly canReply: boolean;
}

export const WAVE_CHAT_REPLY_GROUP_ID = 'chat-group';

const G = WAVE_CHAT_REPLY_GROUP_ID;

// prettier-ignore
export const WAVE_CHAT_REPLY_TRUTH_TABLE: readonly WaveChatReplyTruthTableRow[] = [
    // Chat disabled: nobody replies.
    { chat_enabled: false, chat_group_id: null, chat_replies_open: false, inChatGroup: false, canReply: false },
    { chat_enabled: false, chat_group_id: null, chat_replies_open: false, inChatGroup: true, canReply: false },
    { chat_enabled: false, chat_group_id: null, chat_replies_open: true, inChatGroup: false, canReply: false },
    { chat_enabled: false, chat_group_id: null, chat_replies_open: true, inChatGroup: true, canReply: false },
    { chat_enabled: false, chat_group_id: G, chat_replies_open: false, inChatGroup: false, canReply: false },
    { chat_enabled: false, chat_group_id: G, chat_replies_open: false, inChatGroup: true, canReply: false },
    { chat_enabled: false, chat_group_id: G, chat_replies_open: true, inChatGroup: false, canReply: false },
    { chat_enabled: false, chat_group_id: G, chat_replies_open: true, inChatGroup: true, canReply: false },
    // Chat open to everyone.
    { chat_enabled: true, chat_group_id: null, chat_replies_open: false, inChatGroup: false, canReply: true },
    { chat_enabled: true, chat_group_id: null, chat_replies_open: false, inChatGroup: true, canReply: true },
    { chat_enabled: true, chat_group_id: null, chat_replies_open: true, inChatGroup: false, canReply: true },
    { chat_enabled: true, chat_group_id: null, chat_replies_open: true, inChatGroup: true, canReply: true },
    // Chat limited to a group: members reply, others only when replies are open.
    { chat_enabled: true, chat_group_id: G, chat_replies_open: false, inChatGroup: false, canReply: false },
    { chat_enabled: true, chat_group_id: G, chat_replies_open: false, inChatGroup: true, canReply: true },
    { chat_enabled: true, chat_group_id: G, chat_replies_open: true, inChatGroup: false, canReply: true },
    { chat_enabled: true, chat_group_id: G, chat_replies_open: true, inChatGroup: true, canReply: true }
];
