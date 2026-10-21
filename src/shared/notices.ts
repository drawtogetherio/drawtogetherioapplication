export type NoticeKind = 'friend' | 'friend-accepted' | 'invite' | 'system';

export interface Notice {
  id: string;
  kind: NoticeKind;
  text: string;
  /** friend / friend-accepted: { user, handle, name }. invite: { room: { id, name }, from }. */
  data: Record<string, unknown>;
  read: boolean;
  at: number;
}
