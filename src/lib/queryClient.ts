import { QueryClient } from '@tanstack/react-query';
import { getProject } from './api';

/**
 * Server data cache (TanStack Query). Revisiting a menu shows the last result at once and
 * refreshes it in the background; screens invalidate the keys their changes affect.
 * Cleared when the signed-in user changes (AuthProvider), so no account sees another's data.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000, // a revisit within 15 s reuses the result without a request
      gcTime: 15 * 60_000, // unused results stay 15 min for instant revisits
      retry: 1, // permission (RLS) and missing-table errors do not improve with retries
      refetchOnWindowFocus: true, // pick up teammates' changes when returning to the tab
    },
  },
});

/** Key for one project's data. Invalidating `projectKey(id)` refreshes all of it. */
export const projectKey = (projectId: string, ...parts: unknown[]) => ['project', projectId, ...parts];

/** Project name/code for headers and documents (shared by the shell and the issue export). */
export const projectHeaderQuery = (projectId: string) => ({
  queryKey: projectKey(projectId, 'header'),
  queryFn: () => getProject(projectId),
  staleTime: 5 * 60_000,
});
