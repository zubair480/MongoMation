// Data access for the dashboard: plain react-query polling against the mongomation module's queries.
// Polled reads never toast (a failing read is shown inline as DISCONNECTED / unreachable); mutations
// go through the app-wide error handler, which toasts the server's message.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { callMethod, type MethodArgs } from 'modelence/client';
import {
  POLL_FAST_MS,
  POLL_MS,
  POLL_SLOW_MS,
  type DashboardData,
  type Envelope,
  type PlcSourceData,
  type ProjectData,
  type RsiData,
  type ScenesData,
  type TimelineData,
} from '@/shared/mongomation';

const silent = { errorHandler: () => undefined };

/**
 * When the server computed the ages in a response: the time the response arrived, minus how long the
 * server had already shared that read (`cacheAgeMs`). Live ages = server age + (now - this).
 */
export function receivedAtOf(q: { dataUpdatedAt: number; data?: { cacheAgeMs?: number } }): number {
  return q.dataUpdatedAt - (q.data?.cacheAgeMs ?? 0);
}

function read<T>(method: string, args: MethodArgs = {}) {
  return () => callMethod<Envelope<T>>(`mongomation.${method}`, args, silent);
}

export function useDashboard() {
  return useQuery({
    queryKey: ['mongomation.dashboard'],
    queryFn: read<DashboardData>('dashboard'),
    refetchInterval: POLL_FAST_MS,
    retry: 1,
  });
}

export function useScenes() {
  return useQuery({
    queryKey: ['mongomation.scenes'],
    queryFn: read<ScenesData>('scenes'),
    refetchInterval: POLL_SLOW_MS,
    retry: 1,
  });
}

export function useProject(projectId: string | null) {
  return useQuery({
    queryKey: ['mongomation.project', projectId],
    queryFn: read<ProjectData>('project', { projectId }),
    enabled: !!projectId,
    refetchInterval: POLL_MS,
    retry: 1,
  });
}

/** PLC versions are immutable once written: fetch once, re-poll only while Atlas is unreachable. */
export function usePlcSource(plcVersionId: string | undefined) {
  return useQuery({
    queryKey: ['mongomation.plcSource', plcVersionId],
    queryFn: read<PlcSourceData>('plcSource', { plcVersionId }),
    enabled: !!plcVersionId,
    staleTime: Infinity,
    refetchInterval: (query) => (query.state.data?.connected && query.state.data.found ? false : POLL_MS),
    retry: 1,
  });
}

/** Measurements of a finished test never change; while its sim run is still running, keep polling. */
export function useTimeline(simRunId: string | undefined, testId: string | undefined, live: boolean) {
  return useQuery({
    queryKey: ['mongomation.testTimeline', simRunId, testId],
    queryFn: read<TimelineData>('testTimeline', { simRunId, testId }),
    enabled: !!simRunId && !!testId,
    staleTime: live ? 0 : Infinity,
    refetchInterval: (query) => (live || !query.state.data?.connected ? POLL_MS : false),
    retry: 1,
  });
}

export function useRsi() {
  return useQuery({
    queryKey: ['mongomation.rsi'],
    queryFn: read<RsiData>('rsi'),
    refetchInterval: POLL_MS,
    retry: 1,
  });
}

/** A job request (insert into `jobs`). Errors are toasted by the app-wide handler and kept on `error`. */
export function useJobMutation<TArgs extends MethodArgs, TResult>(method: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: TArgs) => callMethod<TResult>(`mongomation.${method}`, args),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['mongomation.dashboard'] });
    },
  });
}
