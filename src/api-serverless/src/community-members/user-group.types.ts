export enum FilterDirection {
  RECEIVED = 'RECEIVED',
  SENT = 'SENT'
}

export interface FilterMinMax {
  min: number | null;
  max: number | null;
}

export interface FilterMinMaxDirectionAndUser extends FilterMinMax {
  readonly direction: FilterDirection | null;
  user: string | null;
}

export interface FilterRep extends FilterMinMaxDirectionAndUser {
  readonly category: string | null;
}

export interface UserGroup {
  readonly tdh: FilterMinMax;
  readonly rep: FilterRep;
  readonly cic: FilterMinMaxDirectionAndUser;
  readonly level: FilterMinMax;
}
