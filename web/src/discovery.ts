export const DISCOVERY_KEY = 'yuanhuo-merge.discoveries.v1';
type Cache = Pick<Storage, 'getItem' | 'setItem'>;

export function createDiscoveries(cache?: Cache) {
  const seen = new Set<string>();
  try {
    const data: unknown = JSON.parse(cache?.getItem(DISCOVERY_KEY) ?? '[]');
    if (Array.isArray(data)) for (const id of data) if (typeof id === 'string') seen.add(id);
  } catch { /* Corrupt or blocked storage does not block play. */ }
  return {
    has(id: string) { return seen.has(id); },
    mark(id: string) {
      if (seen.has(id)) return false;
      seen.add(id);
      try { cache?.setItem(DISCOVERY_KEY, JSON.stringify([...seen])); } catch { /* Keep in-memory state. */ }
      return true;
    },
  };
}

let cache: Storage | undefined;
try { if (typeof window !== 'undefined') cache = window.localStorage; } catch { /* Private browsing. */ }
export const discoveries = createDiscoveries(cache);
