// Data access for the dashboard. The main views are Modelence LIVE queries (`modelenceLiveQuery`): the
// server pushes a fresh snapshot over the Modelence websocket whenever its shared Atlas change stream sees
// a relevant worker write, so nothing here polls. PLC source and test timelines stay on plain reads.
// Reads never toast (a failing read is shown inline as DISCONNECTED / unreachable); mutations
// go through the app-wide error handler, which toasts the server's message.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { callMethod, modelenceLiveQuery, type MethodArgs } from 'modelence/client';
import {
  POLL_MS,
  type AblationData,
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
  return useQuery(modelenceLiveQuery<Envelope<DashboardData>>('mongomation.liveDashboard'));
}

export function useScenes() {
  return useQuery(modelenceLiveQuery<Envelope<ScenesData>>('mongomation.liveScenes'));
}

export function useProject(projectId: string | null) {
  return useQuery({
    ...modelenceLiveQuery<Envelope<ProjectData>>('mongomation.liveProject', { projectId }),
    enabled: !!projectId,
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

/**
 * Measurements of a finished test never change; while its sim run is still running, keep polling
 * (`measurements` is a time-series collection, which MongoDB change streams cannot watch).
 */
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
  return useQuery(modelenceLiveQuery<Envelope<RsiData>>('mongomation.liveRsi'));
}

export function useAblation() {
  return useQuery(modelenceLiveQuery<Envelope<AblationData>>('mongomation.liveAblation'));
}

/** A job request (insert into `jobs`). Errors are toasted by the app-wide handler and kept on `error`. */
export function useJobMutation<TArgs extends MethodArgs, TResult>(method: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: TArgs) => callMethod<TResult>(`mongomation.${method}`, args),
    onSettled: () => {
      // Live queries refresh themselves from the change stream; this only covers plain-read callers.
      void queryClient.invalidateQueries({ queryKey: ['mongomation.dashboard'] });
    },
  });
}
