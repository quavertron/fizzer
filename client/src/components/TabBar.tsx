export interface Tab {
  id: string;
  title: string;
  type: 'note' | 'chat' | 'superkanban' | 'new' | 'awatch';
  dirty?: boolean;
}
