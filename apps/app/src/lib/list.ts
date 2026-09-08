/** Accept `{ data: T[] }` / `{ rows: T[] }` envelopes or a bare array. */
export function unwrapList<T>(body: unknown): T[] {
  if (Array.isArray(body)) return body as T[];
  if (body && typeof body === "object") {
    const obj = body as { data?: unknown; rows?: unknown };
    if (Array.isArray(obj.data)) return obj.data as T[];
    if (Array.isArray(obj.rows)) return obj.rows as T[];
  }
  return [];
}
