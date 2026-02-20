import { DROP_NFT_LINKS_TABLE } from '@/constants';
import { DropNftLinkEntity } from '@/entities/IDropNftLink';
import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService
} from '@/sql-executor';
import { Timer } from '@/time';
import { DbPoolName } from '@/db-query.options';

export interface DropNftLinkInsertModel {
  readonly url_in_text: string;
  readonly canonical_id: string;
}

export class DropNftLinksDb extends LazyDbAccessCompatibleService {
  async replaceDropLinks(
    {
      dropId,
      links,
      createdAt
    }: {
      dropId: string;
      links: DropNftLinkInsertModel[];
      createdAt: number;
    },
    {
      connection,
      timer
    }: {
      connection: ConnectionWrapper<any>;
      timer?: Timer;
    }
  ) {
    timer?.start(`${this.constructor.name}->replaceDropLinks`);
    try {
      await this.db.execute(
        `delete from ${DROP_NFT_LINKS_TABLE} where drop_id = :dropId`,
        { dropId },
        { wrappedConnection: connection }
      );
      if (!links.length) {
        return;
      }
      const deduplicated = Array.from(
        links
          .reduce((acc, link) => {
            const key = `${link.url_in_text}|${link.canonical_id}`;
            acc.set(key, link);
            return acc;
          }, new Map<string, DropNftLinkInsertModel>())
          .values()
      );
      await Promise.all(
        deduplicated.map((link) =>
          this.db.execute(
            `insert into ${DROP_NFT_LINKS_TABLE} (drop_id, url_in_text, canonical_id, created_at)
             values (:dropId, :url_in_text, :canonical_id, :createdAt)`,
            {
              dropId,
              createdAt,
              url_in_text: link.url_in_text,
              canonical_id: link.canonical_id
            },
            { wrappedConnection: connection }
          )
        )
      );
    } finally {
      timer?.stop(`${this.constructor.name}->replaceDropLinks`);
    }
  }

  async findByDropIds(
    dropIds: string[],
    connection?: ConnectionWrapper<any>,
    forceWritePool = false
  ): Promise<DropNftLinkEntity[]> {
    if (!dropIds.length) {
      return [];
    }
    const queryOptions = connection
      ? { wrappedConnection: connection }
      : forceWritePool
        ? { forcePool: DbPoolName.WRITE }
        : undefined;
    return this.db.execute(
      `select * from ${DROP_NFT_LINKS_TABLE} where drop_id in (:dropIds) order by id asc`,
      { dropIds },
      queryOptions
    );
  }

  async findByDropId(
    dropId: string,
    connection?: ConnectionWrapper<any>,
    forceWritePool = false
  ): Promise<DropNftLinkEntity[]> {
    return this.findByDropIds([dropId], connection, forceWritePool);
  }
}

export const dropNftLinksDb = new DropNftLinksDb(dbSupplier);
