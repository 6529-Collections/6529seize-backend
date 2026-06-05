import {
  DROP_POLL_OPTIONS_TABLE,
  DROP_POLL_VOTES_TABLE,
  DROP_POLLS_TABLE,
  DROPS_TABLE
} from '@/constants';
import {
  DropPollEntity,
  DropPollOptionEntity,
  DropPollVoteEntity
} from '@/entities/IDropPoll';
import { PageSortDirection } from '@/api/page-request';
import { RequestContext } from '@/request.context';
import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';

export enum DropPollState {
  OPEN = 'OPEN',
  CLOSED = 'CLOSED'
}

export enum DropPollsOrderBy {
  CREATED_AT = 'created_at',
  CLOSING_TIME = 'closing_time'
}

export type DropPollOptionWithVotes = DropPollOptionEntity & {
  readonly votes: number;
};

export type DropPollWithOptions = DropPollEntity & {
  readonly created_at?: number;
  readonly options: DropPollOptionWithVotes[];
};

export type CreateDropPollCommand = {
  readonly id: string;
  readonly wave_id: string;
  readonly drop_id: string;
  readonly closing_time: number;
  readonly multichoice: boolean;
  readonly options: readonly {
    readonly option_no: number;
    readonly option_string: string;
  }[];
};

type DropPollOptionVoteRow = DropPollEntity &
  DropPollOptionEntity & {
    readonly votes: number | string;
  };

type DropPollRowWithCreatedAt = DropPollEntity & {
  readonly created_at: number;
};

function toBoolean(value: unknown): boolean {
  return value === true || value === 1 || value === '1';
}

export class DropPollsDb extends LazyDbAccessCompatibleService {
  public async createPoll(
    command: CreateDropPollCommand,
    ctx: RequestContext
  ): Promise<void> {
    const timerKey = `${this.constructor.name}->createPoll`;
    ctx.timer?.start(timerKey);
    try {
      await this.db.execute(
        `
        insert into ${DROP_POLLS_TABLE} (
          id,
          wave_id,
          drop_id,
          closing_time,
          multichoice
        ) values (
          :id,
          :wave_id,
          :drop_id,
          :closing_time,
          :multichoice
        )
      `,
        command,
        { wrappedConnection: ctx.connection }
      );
      await this.db.bulkInsert(
        DROP_POLL_OPTIONS_TABLE,
        command.options.map((option) => ({
          poll_id: command.id,
          wave_id: command.wave_id,
          drop_id: command.drop_id,
          option_no: option.option_no,
          option_string: option.option_string
        })),
        ['poll_id', 'wave_id', 'drop_id', 'option_no', 'option_string'],
        ctx
      );
    } finally {
      ctx.timer?.stop(timerKey);
    }
  }

  public async findPollsByDropIds(
    dropIds: string[],
    ctx: RequestContext
  ): Promise<Record<string, DropPollWithOptions>> {
    if (!dropIds.length) {
      return {};
    }
    const timerKey = `${this.constructor.name}->findPollsByDropIds`;
    ctx.timer?.start(timerKey);
    try {
      const rows = await this.db.execute<DropPollOptionVoteRow>(
        `
        select
          p.id,
          p.wave_id,
          p.drop_id,
          p.closing_time,
          p.multichoice,
          o.option_no,
          o.option_string,
          count(v.voter_id) as votes
        from ${DROP_POLLS_TABLE} p
        join ${DROP_POLL_OPTIONS_TABLE} o on o.poll_id = p.id
        left join ${DROP_POLL_VOTES_TABLE} v
          on v.poll_id = o.poll_id
          and v.option_no = o.option_no
        where p.drop_id in (:dropIds)
        group by
          p.id,
          p.wave_id,
          p.drop_id,
          p.closing_time,
          p.multichoice,
          o.option_no,
          o.option_string
        order by p.drop_id asc, o.option_no asc
      `,
        { dropIds },
        { wrappedConnection: ctx.connection }
      );
      return this.mapPollRowsByDropId(rows);
    } finally {
      ctx.timer?.stop(timerKey);
    }
  }

  public async findPollByDropIdForUpdate(
    dropId: string,
    ctx: RequestContext
  ): Promise<DropPollEntity | null> {
    const timerKey = `${this.constructor.name}->findPollByDropIdForUpdate`;
    ctx.timer?.start(timerKey);
    try {
      return await this.db.oneOrNull<DropPollEntity>(
        `
        select *
        from ${DROP_POLLS_TABLE}
        where drop_id = :dropId
        for update
      `,
        { dropId },
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(timerKey);
    }
  }

  public async findOptionsByPollId(
    pollId: string,
    ctx: RequestContext
  ): Promise<DropPollOptionEntity[]> {
    const timerKey = `${this.constructor.name}->findOptionsByPollId`;
    ctx.timer?.start(timerKey);
    try {
      return await this.db.execute<DropPollOptionEntity>(
        `
        select *
        from ${DROP_POLL_OPTIONS_TABLE}
        where poll_id = :pollId
        order by option_no asc
      `,
        { pollId },
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(timerKey);
    }
  }

  public async replaceVoterVotes(
    {
      pollId,
      waveId,
      dropId,
      voterId,
      optionNos,
      voteTime
    }: {
      readonly pollId: string;
      readonly waveId: string;
      readonly dropId: string;
      readonly voterId: string;
      readonly optionNos: readonly number[];
      readonly voteTime: number;
    },
    ctx: RequestContext
  ): Promise<void> {
    const timerKey = `${this.constructor.name}->replaceVoterVotes`;
    ctx.timer?.start(timerKey);
    try {
      await this.db.execute(
        `
        delete from ${DROP_POLL_VOTES_TABLE}
        where poll_id = :pollId
          and voter_id = :voterId
      `,
        { pollId, voterId },
        { wrappedConnection: ctx.connection }
      );
      await this.db.bulkInsert(
        DROP_POLL_VOTES_TABLE,
        optionNos.map((optionNo) => ({
          poll_id: pollId,
          wave_id: waveId,
          drop_id: dropId,
          option_no: optionNo,
          vote_time: voteTime,
          voter_id: voterId
        })),
        ['poll_id', 'wave_id', 'drop_id', 'option_no', 'vote_time', 'voter_id'],
        ctx
      );
    } finally {
      ctx.timer?.stop(timerKey);
    }
  }

  public async findOptionVoterIds(
    {
      dropId,
      optionNo,
      limit,
      offset
    }: {
      readonly dropId: string;
      readonly optionNo: number;
      readonly limit: number;
      readonly offset: number;
    },
    ctx: RequestContext
  ): Promise<string[]> {
    const timerKey = `${this.constructor.name}->findOptionVoterIds`;
    ctx.timer?.start(timerKey);
    try {
      const rows = await this.db.execute<{ voter_id: string }>(
        `
        select v.voter_id
        from ${DROP_POLLS_TABLE} p
        join ${DROP_POLL_VOTES_TABLE} v on v.poll_id = p.id
        where p.drop_id = :dropId
          and v.option_no = :optionNo
        order by v.vote_time desc, v.voter_id asc
        limit :limit offset :offset
      `,
        { dropId, optionNo, limit, offset },
        { wrappedConnection: ctx.connection }
      );
      return rows.map((row) => row.voter_id);
    } finally {
      ctx.timer?.stop(timerKey);
    }
  }

  public async countOptionVoters(
    {
      dropId,
      optionNo
    }: {
      readonly dropId: string;
      readonly optionNo: number;
    },
    ctx: RequestContext
  ): Promise<number> {
    const timerKey = `${this.constructor.name}->countOptionVoters`;
    ctx.timer?.start(timerKey);
    try {
      const row = await this.db.oneOrNull<{ cnt: number | string }>(
        `
        select count(*) as cnt
        from ${DROP_POLLS_TABLE} p
        join ${DROP_POLL_VOTES_TABLE} v on v.poll_id = p.id
        where p.drop_id = :dropId
          and v.option_no = :optionNo
      `,
        { dropId, optionNo },
        { wrappedConnection: ctx.connection }
      );
      return Number(row?.cnt ?? 0);
    } finally {
      ctx.timer?.stop(timerKey);
    }
  }

  public async findWavePolls(
    {
      waveId,
      limit,
      offset,
      order,
      orderBy,
      state,
      now
    }: {
      readonly waveId: string;
      readonly limit: number;
      readonly offset: number;
      readonly order: PageSortDirection;
      readonly orderBy: DropPollsOrderBy;
      readonly state: DropPollState | null;
      readonly now: number;
    },
    ctx: RequestContext
  ): Promise<DropPollWithOptions[]> {
    const timerKey = `${this.constructor.name}->findWavePolls`;
    ctx.timer?.start(timerKey);
    try {
      const rows = await this.db.execute<DropPollRowWithCreatedAt>(
        `
        select
          p.id,
          p.wave_id,
          p.drop_id,
          p.closing_time,
          p.multichoice,
          d.created_at
        from ${DROP_POLLS_TABLE} p
        join ${DROPS_TABLE} d on d.id = p.drop_id
        where p.wave_id = :waveId
          ${this.getStateFilter(state)}
        order by ${this.getOrderBySql(orderBy)} ${order}, p.id ${order}
        limit :limit offset :offset
      `,
        { waveId, now, limit, offset },
        { wrappedConnection: ctx.connection }
      );
      const optionsByPollId = await this.findOptionsWithVotesByPollIds(
        rows.map((row) => row.id),
        ctx
      );
      return rows.map((row) => ({
        ...this.mapPollRow(row),
        created_at: Number(row.created_at),
        options: optionsByPollId[row.id] ?? []
      }));
    } finally {
      ctx.timer?.stop(timerKey);
    }
  }

  public async countWavePolls(
    {
      waveId,
      state,
      now
    }: {
      readonly waveId: string;
      readonly state: DropPollState | null;
      readonly now: number;
    },
    ctx: RequestContext
  ): Promise<number> {
    const timerKey = `${this.constructor.name}->countWavePolls`;
    ctx.timer?.start(timerKey);
    try {
      const row = await this.db.oneOrNull<{ cnt: number | string }>(
        `
        select count(*) as cnt
        from ${DROP_POLLS_TABLE} p
        where p.wave_id = :waveId
          ${this.getStateFilter(state)}
      `,
        { waveId, now },
        { wrappedConnection: ctx.connection }
      );
      return Number(row?.cnt ?? 0);
    } finally {
      ctx.timer?.stop(timerKey);
    }
  }

  public async deleteByDropId(
    dropId: string,
    ctx: RequestContext
  ): Promise<void> {
    const timerKey = `${this.constructor.name}->deleteByDropId`;
    ctx.timer?.start(timerKey);
    try {
      await Promise.all([
        this.db.execute(
          `delete from ${DROP_POLL_VOTES_TABLE} where drop_id = :dropId`,
          { dropId },
          { wrappedConnection: ctx.connection }
        ),
        this.db.execute(
          `delete from ${DROP_POLL_OPTIONS_TABLE} where drop_id = :dropId`,
          { dropId },
          { wrappedConnection: ctx.connection }
        ),
        this.db.execute(
          `delete from ${DROP_POLLS_TABLE} where drop_id = :dropId`,
          { dropId },
          { wrappedConnection: ctx.connection }
        )
      ]);
    } finally {
      ctx.timer?.stop(timerKey);
    }
  }

  public async deleteByWaveId(
    waveId: string,
    ctx: RequestContext
  ): Promise<void> {
    const timerKey = `${this.constructor.name}->deleteByWaveId`;
    ctx.timer?.start(timerKey);
    try {
      await Promise.all([
        this.db.execute(
          `delete from ${DROP_POLL_VOTES_TABLE} where wave_id = :waveId`,
          { waveId },
          { wrappedConnection: ctx.connection }
        ),
        this.db.execute(
          `delete from ${DROP_POLL_OPTIONS_TABLE} where wave_id = :waveId`,
          { waveId },
          { wrappedConnection: ctx.connection }
        ),
        this.db.execute(
          `delete from ${DROP_POLLS_TABLE} where wave_id = :waveId`,
          { waveId },
          { wrappedConnection: ctx.connection }
        )
      ]);
    } finally {
      ctx.timer?.stop(timerKey);
    }
  }

  public async mergeOnProfileIdChange(
    {
      previous_id,
      new_id
    }: {
      readonly previous_id: string;
      readonly new_id: string;
    },
    ctx: RequestContext
  ): Promise<void> {
    const timerKey = `${this.constructor.name}->mergeOnProfileIdChange`;
    ctx.timer?.start(timerKey);
    try {
      const params = { previous_id, new_id };
      await this.db.execute(
        `
        delete source_votes
        from ${DROP_POLL_VOTES_TABLE} source_votes
        join ${DROP_POLL_VOTES_TABLE} target_votes
          on target_votes.poll_id = source_votes.poll_id
          and target_votes.voter_id = :new_id
        where source_votes.voter_id = :previous_id
      `,
        params,
        { wrappedConnection: ctx.connection }
      );
      await this.db.execute(
        `
        update ${DROP_POLL_VOTES_TABLE}
        set voter_id = :new_id
        where voter_id = :previous_id
      `,
        params,
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(timerKey);
    }
  }

  private async findOptionsWithVotesByPollIds(
    pollIds: string[],
    ctx: RequestContext
  ): Promise<Record<string, DropPollOptionWithVotes[]>> {
    if (!pollIds.length) {
      return {};
    }
    const rows = await this.db.execute<
      DropPollOptionEntity & { votes: number | string }
    >(
      `
      select
        o.poll_id,
        o.wave_id,
        o.drop_id,
        o.option_no,
        o.option_string,
        count(v.voter_id) as votes
      from ${DROP_POLL_OPTIONS_TABLE} o
      left join ${DROP_POLL_VOTES_TABLE} v
        on v.poll_id = o.poll_id
        and v.option_no = o.option_no
      where o.poll_id in (:pollIds)
      group by
        o.poll_id,
        o.wave_id,
        o.drop_id,
        o.option_no,
        o.option_string
      order by o.poll_id asc, o.option_no asc
    `,
      { pollIds },
      { wrappedConnection: ctx.connection }
    );
    return rows.reduce(
      (acc, row) => {
        const options = acc[row.poll_id] ?? [];
        options.push({
          poll_id: row.poll_id,
          wave_id: row.wave_id,
          drop_id: row.drop_id,
          option_no: Number(row.option_no),
          option_string: row.option_string,
          votes: Number(row.votes)
        });
        acc[row.poll_id] = options;
        return acc;
      },
      {} as Record<string, DropPollOptionWithVotes[]>
    );
  }

  private mapPollRowsByDropId(
    rows: DropPollOptionVoteRow[]
  ): Record<string, DropPollWithOptions> {
    return rows.reduce(
      (acc, row) => {
        const poll = acc[row.drop_id] ?? {
          ...this.mapPollRow(row),
          options: []
        };
        poll.options.push({
          poll_id: row.id,
          wave_id: row.wave_id,
          drop_id: row.drop_id,
          option_no: Number(row.option_no),
          option_string: row.option_string,
          votes: Number(row.votes)
        });
        acc[row.drop_id] = poll;
        return acc;
      },
      {} as Record<string, DropPollWithOptions>
    );
  }

  private mapPollRow(row: DropPollEntity): DropPollEntity {
    return {
      id: row.id,
      wave_id: row.wave_id,
      drop_id: row.drop_id,
      closing_time: Number(row.closing_time),
      multichoice: toBoolean(row.multichoice)
    };
  }

  private getOrderBySql(orderBy: DropPollsOrderBy): string {
    switch (orderBy) {
      case DropPollsOrderBy.CREATED_AT:
        return 'd.created_at';
      case DropPollsOrderBy.CLOSING_TIME:
        return 'p.closing_time';
    }
  }

  private getStateFilter(state: DropPollState | null): string {
    switch (state) {
      case DropPollState.OPEN:
        return 'and p.closing_time > :now';
      case DropPollState.CLOSED:
        return 'and p.closing_time <= :now';
      case null:
        return '';
    }
  }
}

export const dropPollsDb = new DropPollsDb(dbSupplier);
