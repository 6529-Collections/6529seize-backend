import { ApiCreateNewProfileProxyAllocateCicAction } from '../generated/models/ApiCreateNewProfileProxyAllocateCicAction';
import { ApiCreateNewProfileProxyAllocateRepAction } from '../generated/models/ApiCreateNewProfileProxyAllocateRepAction';
import { ApiCreateNewProfileProxyCreateWaveParticipationDropAction } from '../generated/models/ApiCreateNewProfileProxyCreateWaveParticipationDropAction';
import { ApiCreateNewProfileProxyCreateWaveAction } from '../generated/models/ApiCreateNewProfileProxyCreateWaveAction';
import { ApiCreateNewProfileProxyReadWaveAction } from '../generated/models/ApiCreateNewProfileProxyReadWaveAction';

export type ProxyApiRequestAction =
  | ApiCreateNewProfileProxyAllocateRepAction
  | ApiCreateNewProfileProxyAllocateCicAction
  | ApiCreateNewProfileProxyCreateWaveAction
  | ApiCreateNewProfileProxyReadWaveAction
  | ApiCreateNewProfileProxyCreateWaveParticipationDropAction;
