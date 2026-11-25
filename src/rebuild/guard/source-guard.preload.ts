// Loaded with `-r` into every Node process the rebuild run starts. Only
// relative imports: command steps load it through NODE_OPTIONS, without the
// path aliases.
import {
  installSourceGuard,
  parseAllowedEndpoints,
  violationFileWriter
} from './source-guard';

const violations = process.env.REBUILD_VIOLATIONS_FILE;
if (!violations) {
  throw new Error('REBUILD_VIOLATIONS_FILE must be set for the source guard');
}
installSourceGuard({
  allowed: parseAllowedEndpoints(process.env.REBUILD_ALLOWED_ENDPOINTS),
  onViolation: violationFileWriter(violations)
});
