export interface DeleteDropModel {
  readonly drop_id: string;
  readonly deleter_identity?: string;
  readonly deletion_purpose: 'DELETE' | 'UPDATE' | 'SYSTEM_DELETE';
  readonly deleter_id?: string;
}
