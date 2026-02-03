import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService
} from '../../../sql-executor';
import { DROP_BOOKMARKS_TABLE } from '@/constants';
import { Time } from '../../../time';

export class DropBookmarksDb extends LazyDbAccessCompatibleService {
  async insertBookmark(
    param: { identity_id: string; drop_id: string },
    connection?: ConnectionWrapper<any>
  ): Promise<void> {
    await this.db.execute(
      `
        INSERT INTO ${DROP_BOOKMARKS_TABLE} (identity_id, drop_id, bookmarked_at)
        VALUES (:identity_id, :drop_id, :bookmarked_at)
        ON DUPLICATE KEY UPDATE bookmarked_at = bookmarked_at
      `,
      {
        identity_id: param.identity_id,
        drop_id: param.drop_id,
        bookmarked_at: Time.currentMillis()
      },
      connection ? { wrappedConnection: connection } : undefined
    );
  }

  async deleteBookmark(
    param: { identity_id: string; drop_id: string },
    connection?: ConnectionWrapper<any>
  ): Promise<void> {
    await this.db.execute(
      `DELETE FROM ${DROP_BOOKMARKS_TABLE} WHERE identity_id = :identity_id AND drop_id = :drop_id`,
      param,
      connection ? { wrappedConnection: connection } : undefined
    );
  }

  async deleteBookmarksByDropId(
    dropId: string,
    connection?: ConnectionWrapper<any>
  ): Promise<void> {
    await this.db.execute(
      `DELETE FROM ${DROP_BOOKMARKS_TABLE} WHERE drop_id = :drop_id`,
      { drop_id: dropId },
      connection ? { wrappedConnection: connection } : undefined
    );
  }

  async isDropBookmarkedByIdentity(
    param: { identity_id: string; drop_id: string },
    connection?: ConnectionWrapper<any>
  ): Promise<boolean> {
    const result = await this.db.execute<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM ${DROP_BOOKMARKS_TABLE} WHERE identity_id = :identity_id AND drop_id = :drop_id`,
      param,
      connection ? { wrappedConnection: connection } : undefined
    );
    return result[0].cnt > 0;
  }

  async findBookmarkedDropIds(
    param: {
      identity_id: string;
      drop_ids: string[];
    },
    connection?: ConnectionWrapper<any>
  ): Promise<Set<string>> {
    if (param.drop_ids.length === 0) {
      return new Set();
    }
    const result = await this.db.execute<{ drop_id: string }>(
      `SELECT drop_id FROM ${DROP_BOOKMARKS_TABLE} WHERE identity_id = :identity_id AND drop_id IN (:drop_ids)`,
      { identity_id: param.identity_id, drop_ids: param.drop_ids },
      connection ? { wrappedConnection: connection } : undefined
    );
    return new Set(result.map((r) => r.drop_id));
  }

  async findBookmarkedDropsForIdentity(
    param: {
      identity_id: string;
      wave_id: string | null;
      page_size: number;
      page: number;
      sort_direction: 'ASC' | 'DESC';
      group_ids_user_is_eligible_for: string[];
    },
    connection?: ConnectionWrapper<any>
  ): Promise<{ drop_ids: string[]; count: number }> {
    const offset = param.page_size * (param.page - 1);
    const waveFilter = param.wave_id ? 'AND d.wave_id = :wave_id' : '';
    const visibilityFilter =
      param.group_ids_user_is_eligible_for.length > 0
        ? `AND (w.visibility_group_id IS NULL OR w.visibility_group_id IN (:group_ids))`
        : `AND w.visibility_group_id IS NULL`;

    const [data, countResult] = await Promise.all([
      this.db.execute<{ drop_id: string }>(
        `
        SELECT b.drop_id
        FROM ${DROP_BOOKMARKS_TABLE} b
        JOIN drops d ON d.id = b.drop_id
        JOIN waves w ON w.id = d.wave_id
        WHERE b.identity_id = :identity_id
        ${waveFilter}
        ${visibilityFilter}
        ORDER BY b.bookmarked_at ${param.sort_direction}
        LIMIT :limit OFFSET :offset
        `,
        {
          identity_id: param.identity_id,
          wave_id: param.wave_id,
          group_ids: param.group_ids_user_is_eligible_for,
          limit: param.page_size,
          offset
        },
        connection ? { wrappedConnection: connection } : undefined
      ),
      this.db.execute<{ cnt: number }>(
        `
        SELECT COUNT(*) as cnt
        FROM ${DROP_BOOKMARKS_TABLE} b
        JOIN drops d ON d.id = b.drop_id
        JOIN waves w ON w.id = d.wave_id
        WHERE b.identity_id = :identity_id
        ${waveFilter}
        ${visibilityFilter}
        `,
        {
          identity_id: param.identity_id,
          wave_id: param.wave_id,
          group_ids: param.group_ids_user_is_eligible_for
        },
        connection ? { wrappedConnection: connection } : undefined
      )
    ]);

    return {
      drop_ids: data.map((r) => r.drop_id),
      count: countResult[0].cnt
    };
  }

  async mergeOnProfileIdChange(
    param: { previous_id: string; new_id: string },
    ctx: { connection: ConnectionWrapper<any> }
  ): Promise<void> {
    await this.db.execute(
      `
        UPDATE ${DROP_BOOKMARKS_TABLE} b1
        LEFT JOIN ${DROP_BOOKMARKS_TABLE} b2 ON b2.identity_id = :new_id AND b2.drop_id = b1.drop_id
        SET b1.identity_id = :new_id
        WHERE b1.identity_id = :previous_id AND b2.identity_id IS NULL
      `,
      param,
      { wrappedConnection: ctx.connection }
    );
    await this.db.execute(
      `DELETE FROM ${DROP_BOOKMARKS_TABLE} WHERE identity_id = :previous_id`,
      { previous_id: param.previous_id },
      { wrappedConnection: ctx.connection }
    );
  }
}

export const dropBookmarksDb = new DropBookmarksDb(dbSupplier);
