import { randomUUID } from 'node:crypto';
import { BadRequestException, NotFoundException } from '@/exceptions';
import { ConnectionWrapper } from '@/sql-executor';
import {
  MAX_MEMBERS_PER_MENTION_ALIAS,
  MAX_MENTION_ALIASES_PER_PROFILE,
  MENTION_ALIAS_MAX_LENGTH,
  MENTION_ALIAS_MIN_LENGTH,
  isReservedMentionAlias,
  normalizeMentionAlias
} from './mention-aliases.constants';
import {
  MentionAlias,
  MentionAliasesDb,
  mentionAliasesDb
} from './mention-aliases.db';

export interface MentionAliasInput {
  readonly alias: string;
  readonly member_profile_ids: string[];
}

export class MentionAliasesService {
  constructor(private readonly db: MentionAliasesDb) {}

  async list(ownerProfileId: string): Promise<MentionAlias[]> {
    return this.db.findByOwner(ownerProfileId);
  }

  async create(
    ownerProfileId: string,
    input: MentionAliasInput
  ): Promise<MentionAlias> {
    const normalized = this.validateInput(input);
    const id = randomUUID();
    await this.db.executeNativeQueriesInTransaction(async (connection) => {
      const ownerLocked = await this.db.lockOwnerProfile(
        ownerProfileId,
        connection
      );
      if (!ownerLocked) {
        throw new NotFoundException('Profile not found.');
      }
      const count = await this.db.countByOwner(ownerProfileId, connection);
      if (count >= MAX_MENTION_ALIASES_PER_PROFILE) {
        throw new BadRequestException(
          `You can create up to ${MAX_MENTION_ALIASES_PER_PROFILE} mention shortcuts.`
        );
      }
      await this.validateUniqueAndMembers({
        ownerProfileId,
        normalizedAlias: normalized.alias,
        memberProfileIds: normalized.memberProfileIds,
        excludedAliasId: null,
        connection
      });
      try {
        await this.db.insertAlias(
          {
            id,
            ownerProfileId,
            alias: normalized.alias,
            normalizedAlias: normalized.alias
          },
          connection
        );
      } catch (error) {
        if (isDuplicateKeyError(error)) {
          throw new BadRequestException(
            `You already have a @${normalized.alias} mention shortcut.`
          );
        }
        throw error;
      }
      await this.db.replaceMembers(id, normalized.memberProfileIds, connection);
    });
    return this.findCreatedOrThrow(ownerProfileId, id);
  }

  async update(
    ownerProfileId: string,
    aliasId: string,
    input: MentionAliasInput
  ): Promise<MentionAlias> {
    const normalized = this.validateInput(input);
    await this.db.executeNativeQueriesInTransaction(async (connection) => {
      const existing = await this.db.findOwnedAlias(
        aliasId,
        ownerProfileId,
        connection
      );
      if (!existing) {
        throw new NotFoundException('Mention shortcut not found.');
      }
      await this.validateUniqueAndMembers({
        ownerProfileId,
        normalizedAlias: normalized.alias,
        memberProfileIds: normalized.memberProfileIds,
        excludedAliasId: aliasId,
        connection
      });
      try {
        await this.db.updateAliasName(
          aliasId,
          normalized.alias,
          normalized.alias,
          connection
        );
      } catch (error) {
        if (isDuplicateKeyError(error)) {
          throw new BadRequestException(
            `You already have a @${normalized.alias} mention shortcut.`
          );
        }
        throw error;
      }
      await this.db.replaceMembers(
        aliasId,
        normalized.memberProfileIds,
        connection
      );
    });
    return this.findCreatedOrThrow(ownerProfileId, aliasId);
  }

  async delete(ownerProfileId: string, aliasId: string): Promise<void> {
    await this.db.executeNativeQueriesInTransaction(async (connection) => {
      const existing = await this.db.findOwnedAlias(
        aliasId,
        ownerProfileId,
        connection
      );
      if (!existing) {
        throw new NotFoundException('Mention shortcut not found.');
      }
      await this.db.deleteAlias(aliasId, connection);
    });
  }

  private validateInput(input: MentionAliasInput): {
    alias: string;
    memberProfileIds: string[];
  } {
    const alias = normalizeMentionAlias(input.alias);
    if (
      alias.length < MENTION_ALIAS_MIN_LENGTH ||
      alias.length > MENTION_ALIAS_MAX_LENGTH ||
      !/^\w+$/.test(alias)
    ) {
      throw new BadRequestException(
        `Mention shortcuts must use ${MENTION_ALIAS_MIN_LENGTH}-${MENTION_ALIAS_MAX_LENGTH} letters, numbers, or underscores.`
      );
    }
    if (isReservedMentionAlias(alias)) {
      throw new BadRequestException(
        `@${alias} is reserved. Try something a little more creative.`
      );
    }
    const memberProfileIds = Array.from(new Set(input.member_profile_ids));
    if (!memberProfileIds.length) {
      throw new BadRequestException(
        'Mention shortcuts must contain at least one profile.'
      );
    }
    if (memberProfileIds.length > MAX_MEMBERS_PER_MENTION_ALIAS) {
      throw new BadRequestException(
        `Mention shortcuts can contain up to ${MAX_MEMBERS_PER_MENTION_ALIAS} profiles.`
      );
    }
    return { alias, memberProfileIds };
  }

  private async validateUniqueAndMembers({
    ownerProfileId,
    normalizedAlias,
    memberProfileIds,
    excludedAliasId,
    connection
  }: {
    ownerProfileId: string;
    normalizedAlias: string;
    memberProfileIds: string[];
    excludedAliasId: string | null;
    connection: ConnectionWrapper<any>;
  }) {
    const [duplicate, existingProfileIds] = await Promise.all([
      this.db.normalizedAliasExists(
        ownerProfileId,
        normalizedAlias,
        excludedAliasId,
        connection
      ),
      this.db.findMentionableProfileIds(memberProfileIds, connection)
    ]);
    if (duplicate) {
      throw new BadRequestException(
        `You already have a @${normalizedAlias} mention shortcut.`
      );
    }
    if (existingProfileIds.length !== memberProfileIds.length) {
      throw new BadRequestException(
        'One or more mention shortcut profiles no longer exist or do not have a handle.'
      );
    }
  }

  private async findCreatedOrThrow(
    ownerProfileId: string,
    aliasId: string
  ): Promise<MentionAlias> {
    const alias = (await this.db.findByOwner(ownerProfileId)).find(
      (item) => item.id === aliasId
    );
    if (!alias) {
      throw new NotFoundException('Mention shortcut not found.');
    }
    return alias;
  }
}

export const mentionAliasesService = new MentionAliasesService(
  mentionAliasesDb
);

function isDuplicateKeyError(error: unknown): boolean {
  if (!isErrorRecord(error)) return false;
  if (error.code === 'ER_DUP_ENTRY' || error.errno === 1062) return true;
  return isDuplicateKeyDetails(error.driverError);
}

function isDuplicateKeyDetails(error: unknown): boolean {
  return (
    isErrorRecord(error) &&
    (error.code === 'ER_DUP_ENTRY' || error.errno === 1062)
  );
}

function isErrorRecord(error: unknown): error is Record<string, unknown> {
  return typeof error === 'object' && error !== null;
}
