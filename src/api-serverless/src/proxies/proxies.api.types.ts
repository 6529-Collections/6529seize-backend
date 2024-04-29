import { CreateNewProfileProxyAllocateCicAction } from '../generated/models/CreateNewProfileProxyAllocateCicAction';
import { CreateNewProfileProxyAllocateRepAction } from '../generated/models/CreateNewProfileProxyAllocateRepAction';
import { CreateNewProfileProxyCreateWaveParticipationDropAction } from '../generated/models/CreateNewProfileProxyCreateWaveParticipationDropAction';
import { CreateNewProfileProxyCreateWaveAction } from '../generated/models/CreateNewProfileProxyCreateWaveAction';
import { CreateNewProfileProxyReadWaveAction } from '../generated/models/CreateNewProfileProxyReadWaveAction';

export type ProxyApiRequestAction =
  | CreateNewProfileProxyAllocateRepAction
  | CreateNewProfileProxyAllocateCicAction
  | CreateNewProfileProxyCreateWaveAction
  | CreateNewProfileProxyReadWaveAction
  | CreateNewProfileProxyCreateWaveParticipationDropAction;
