import { Seed } from '../_setup/seed';
import { ABUSIVENESS_DETECTION_RESULTS_TABLE } from '@/constants';
import { AbusivenessDetectionResult } from '../../entities/IAbusivenessDetectionResult';
import { Time } from '../../time';

const defaultAbusivenessDetectionResult: AbusivenessDetectionResult = {
  text: 'text',
  status: 'ALLOWED',
  explanation: null,
  external_check_performed_at: Time.millis(0).toDate()
};

export function anAbusivenessDetectionResult(
  props: Partial<AbusivenessDetectionResult>
): AbusivenessDetectionResult {
  return {
    ...defaultAbusivenessDetectionResult,
    ...props
  };
}

export function withAbusivenessDetectionResults(
  entities: AbusivenessDetectionResult[]
): Seed {
  return {
    table: ABUSIVENESS_DETECTION_RESULTS_TABLE,
    rows: entities
  };
}
