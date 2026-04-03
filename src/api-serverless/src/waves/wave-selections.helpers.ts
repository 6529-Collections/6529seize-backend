import { ApiWaveSelection } from '@/api/generated/models/ApiWaveSelection';
import { WaveSelectionEntity } from '@/entities/IWaveSelection';

export function mapWaveSelectionEntityToApiWaveSelection(
  entity: Pick<WaveSelectionEntity, 'id' | 'title'>
): ApiWaveSelection {
  return {
    id: entity.id,
    title: entity.title
  };
}

export function groupWaveSelectionsByWaveId(
  entities: WaveSelectionEntity[]
): Record<string, ApiWaveSelection[]> {
  return entities.reduce(
    (acc, entity) => {
      const selections = acc[entity.wave_id] ?? [];
      selections.push(mapWaveSelectionEntityToApiWaveSelection(entity));
      acc[entity.wave_id] = selections;
      return acc;
    },
    {} as Record<string, ApiWaveSelection[]>
  );
}

export function groupWaveSelectionsByDropId(
  entities: Array<
    Pick<WaveSelectionEntity, 'id' | 'title'> & { drop_id: string }
  >
): Record<string, ApiWaveSelection[]> {
  return entities.reduce(
    (acc, entity) => {
      const selections = acc[entity.drop_id] ?? [];
      selections.push(mapWaveSelectionEntityToApiWaveSelection(entity));
      acc[entity.drop_id] = selections;
      return acc;
    },
    {} as Record<string, ApiWaveSelection[]>
  );
}
