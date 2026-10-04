import { useCallback, useRef } from 'react';
import { useQuery, useQueryClient, type PlaceholderDataFunction, type QueryKey, type UseQueryOptions } from '@tanstack/react-query';

type Next<T> = T | ((prev: T) => T);

/**
 * Cached server state with a useState-like API:
 *   const [logs, setLogs, refreshLogs, query] = useCachedQuery(projectKey(id, 'logs'), () => listLogs(id), []);
 * A revisit shows the cached value immediately while it refetches. `set` writes the cache
 * (optimistic edits, or a list re-read after a change) and `refresh` refetches.
 * `initial` is returned until the first result arrives (kept stable across renders).
 */
export function useCachedQuery<T>(
  key: QueryKey,
  load: () => Promise<T>,
  initial: T,
  options: {
    enabled?: boolean;
    staleTime?: number;
    /** While a key that differs only in its last part loads (e.g. a longer page), keep showing the
     *  previous result. Never across other changes (another project must not show this one's data). */
    keepPrevious?: boolean;
  } = {},
) {
  const qc = useQueryClient();
  const fallback = useRef(initial).current;
  const { keepPrevious, ...rest } = options;
  const hash = JSON.stringify(key);
  const scope = JSON.stringify(key.slice(0, -1));
  const sameScope: PlaceholderDataFunction<T, Error, T, QueryKey> = (prev, prevQuery) =>
    prevQuery && JSON.stringify(prevQuery.queryKey.slice(0, -1)) === scope ? prev : undefined;
  const query = useQuery<T, Error, T, QueryKey>({
    queryKey: key,
    queryFn: load,
    ...rest,
    // (cast: TanStack narrows function-typed data; T is never a function here)
    placeholderData: (keepPrevious ? sameScope : undefined) as UseQueryOptions<T, Error, T, QueryKey>['placeholderData'],
  });
  /* eslint-disable react-hooks/exhaustive-deps -- `hash` stands for `key`, a new array each render */
  const set = useCallback((next: Next<T>) => {
    qc.setQueryData<T>(key, (prev) =>
      typeof next === 'function' ? (next as (p: T) => T)(prev ?? fallback) : next);
  }, [qc, hash]);
  const refresh = useCallback(() => qc.invalidateQueries({ queryKey: key }), [qc, hash]);
  /* eslint-enable react-hooks/exhaustive-deps */
  return [query.data ?? fallback, set, refresh, query] as const;
}
