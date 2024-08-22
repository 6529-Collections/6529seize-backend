import { ConnectionWrapper } from './sql-executor';
import { Timer } from './time';
import { AuthenticationContext } from './auth-context';

export interface RequestContext {
  readonly connection?: ConnectionWrapper<any>;
  readonly timer?: Timer;
  readonly authenticationContext?: AuthenticationContext;
}
