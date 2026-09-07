export interface Tab {
  id: string;
  title: string;
  type: 'note' | 'chat' | 'mission' | 'superkanban' | 'new';
  dirty?: boolean;
}
