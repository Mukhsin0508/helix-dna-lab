/** Public account identity. Authentication secrets never appear in API responses. */
export interface Account {
  id: string;
  displayName: string;
}

export interface PasskeySummary {
  id: string;
  createdAt: string;
  lastUsedAt: string | null;
  deviceType: 'singleDevice' | 'multiDevice';
  backedUp: boolean;
}
