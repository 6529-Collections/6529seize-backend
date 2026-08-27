import 'reflect-metadata';
import {
  WAVE_DROPPER_METRICS_TABLE,
  WAVE_METRICS_TABLE,
  WAVES_TABLE
} from '@/constants';
import { WaveMetricEntity } from '@/entities/IWaveMetric';
import { RequestContext } from '@/request.context';
import { getMetadataArgsStorage } from 'typeorm';
import { WavesApiDb } from './waves.api.db';

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

describe('WavesApiDb profile wave activity queries', () => {
  it('uses the stable CREATED keyset and effective parent privacy in one query', async () => {
    const execute = jest.fn().mockResolvedValue([
      {
        wave_id: 'wave-1',
        wave_name: 'Wave One',
        wave_picture: null,
        is_private: 1,
        total_drops_count: 4,
        target_latest_post_timestamp: 0,
        has_qualifying_post: 0,
        wave_serial_no: 10
      }
    ]);
    const repo = new WavesApiDb(() => ({ execute }) as any);

    const result = await repo.findCreatedProfileWaveActivity(
      {
        profileId: 'profile-1',
        eligibleGroups: ['group-1'],
        limit: 21,
        cursor: {
          hasQualifyingPost: 1,
          latestPostTimestamp: 500,
          waveSerialNo: 20,
          waveId: 'wave-2'
        }
      },
      { timer: undefined } as RequestContext
    );

    expect(execute).toHaveBeenCalledTimes(1);
    const [rawSql, params] = execute.mock.calls[0];
    const sql = normalizeSql(rawSql);
    expect(sql).toContain(
      'case when w.visibility_group_id is not null or parent.visibility_group_id is not null then 1 else 0 end as is_private'
    );
    expect(sql).not.toContain('admin_group_id');
    expect(sql).toContain(
      `left join ${WAVE_DROPPER_METRICS_TABLE} wdm on wdm.wave_id = w.id and wdm.dropper_id = :profileId`
    );
    expect(sql).toContain(
      `left join ${WAVE_METRICS_TABLE} wm on wm.wave_id = w.id`
    );
    expect(sql).toContain(
      'coalesce(wdm.latest_drop_timestamp, 0) < :cursorLatestPostTimestamp'
    );
    expect(sql).toContain('w.serial_no < :cursorWaveSerialNo');
    expect(sql).toContain('w.id < :cursorWaveId');
    expect(sql).toContain(
      'order by has_qualifying_post desc, target_latest_post_timestamp desc, w.serial_no desc, w.id desc'
    );
    expect(sql).toContain(
      'parent.id is not null and parent.parent_wave_id is null'
    );
    expect(sql).toContain(
      'parent.visibility_group_id is null or parent.visibility_group_id in (:eligibleGroups)'
    );
    expect(sql).not.toContain('select w.*');
    expect(params).toEqual(
      expect.objectContaining({
        profileId: 'profile-1',
        eligibleGroups: ['group-1'],
        limit: 21,
        cursorHasQualifyingPost: 1,
        cursorLatestPostTimestamp: 500,
        cursorWaveSerialNo: 20,
        cursorWaveId: 'wave-2'
      })
    );
    expect(result).toEqual([
      {
        waveId: 'wave-1',
        waveName: 'Wave One',
        wavePicture: null,
        isPrivate: true,
        totalDropsCount: 4,
        latestPostTimestamp: null,
        hasQualifyingPost: false,
        waveSerialNo: 10
      }
    ]);
  });

  it('uses the stable RECENT keyset and effective parent privacy in one query', async () => {
    const execute = jest.fn().mockResolvedValue([
      {
        wave_id: 'wave-1',
        wave_name: 'Wave One',
        wave_picture: 'picture-1',
        is_private: '1',
        total_drops_count: '7',
        target_latest_post_timestamp: '400'
      }
    ]);
    const repo = new WavesApiDb(() => ({ execute }) as any);

    const result = await repo.findRecentProfileWaveActivity(
      {
        profileId: 'profile-1',
        eligibleGroups: ['group-1'],
        limit: 21,
        cursor: { latestPostTimestamp: 500, waveId: 'wave-2' }
      },
      { timer: undefined } as RequestContext
    );

    expect(execute).toHaveBeenCalledTimes(1);
    const [rawSql, params] = execute.mock.calls[0];
    const sql = normalizeSql(rawSql);
    expect(sql).toContain(
      'case when w.visibility_group_id is not null or parent.visibility_group_id is not null then 1 else 0 end as is_private'
    );
    expect(sql).not.toContain('admin_group_id');
    expect(sql).toContain(
      `from ${WAVE_DROPPER_METRICS_TABLE} wdm join ${WAVES_TABLE} w on w.id = wdm.wave_id`
    );
    expect(sql).toContain(
      `left join ${WAVE_METRICS_TABLE} wm on wm.wave_id = w.id`
    );
    expect(sql).toContain('wdm.latest_drop_timestamp > 0');
    expect(sql).toContain(
      'wdm.latest_drop_timestamp < :cursorLatestPostTimestamp'
    );
    expect(sql).toContain('wdm.wave_id < :cursorWaveId');
    expect(sql).toContain(
      'order by wdm.latest_drop_timestamp desc, wdm.wave_id desc'
    );
    expect(sql).toContain(
      'parent.visibility_group_id is null or parent.visibility_group_id in (:eligibleGroups)'
    );
    expect(sql).not.toContain('select w.*');
    expect(params).toEqual(
      expect.objectContaining({
        profileId: 'profile-1',
        eligibleGroups: ['group-1'],
        limit: 21,
        cursorLatestPostTimestamp: 500,
        cursorWaveId: 'wave-2'
      })
    );
    expect(result).toEqual([
      {
        waveId: 'wave-1',
        waveName: 'Wave One',
        wavePicture: 'picture-1',
        isPrivate: true,
        totalDropsCount: 7,
        latestPostTimestamp: 400
      }
    ]);
  });

  it('joins the one-row-per-wave metrics source for total drop counts', () => {
    const waveIdColumn = getMetadataArgsStorage().columns.find(
      (column) =>
        column.target === WaveMetricEntity && column.propertyName === 'wave_id'
    );

    expect(waveIdColumn?.options.primary).toBe(true);
  });
});
