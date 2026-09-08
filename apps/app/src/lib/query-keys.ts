export const queryKeys = {
  me: () => ["me"] as const,
  resource: (path: string) => ["resource", path] as const,
  dashboard: {
    stats: () => ["dashboard", "stats"] as const,
  },
  leave: {
    requests: () => ["leave", "requests"] as const,
    types: () => ["leave", "types"] as const,
  },
  travel: {
    requests: () => ["travel", "requests"] as const,
  },
  expenses: {
    reports: () => ["expenses", "reports"] as const,
  },
  aria: {
    conversations: () => ["aria", "conversations"] as const,
    conversation: (id: string) => ["aria", "conversation", id] as const,
  },
};
