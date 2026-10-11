// Hooks for the Modelence-native extras: live analytics / notes / ops (live queries), failure search
// (Atlas Search, plain reads), note + AI mutations, and the live worker event channel (ClientChannel).
import * as React from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  ClientChannel,
  callMethod,
  getWebsocketClientProvider,
  modelenceLiveQuery,
  startWebsockets,
  type MethodArgs,
} from 'modelence/client';
import type { Envelope, EventLite } from '@/shared/mongomation';
import {
  EVENTS_CHANNEL,
  type AnalyticsData,
  type ArtifactLinksData,
  type RigAwsData,
  type FailureFacetsData,
  type FailureSearchData,
  type FailureSuggestData,
  type LiveEventMessage,
  type NotesData,
  type OpsData,
} from '@/shared/insights';

const silent = { errorHandler: () => undefined };

export function useAnalytics(projectId: string | null) {
  return useQuery({
    ...modelenceLiveQuery<Envelope<AnalyticsData>>('mongomation.liveAnalytics', { projectId }),
    enabled: !!projectId,
  });
}

export function useNotes(projectId: string | null) {
  return useQuery({ ...modelenceLiveQuery<NotesData>('mongomation.liveNotes', { projectId }), enabled: !!projectId });
}

export function useOps() {
  return useQuery(modelenceLiveQuery<OpsData>('mongomation.liveOps'));
}

export function useAppMutation<TArgs extends MethodArgs, TResult = unknown>(method: string) {
  return useMutation({ mutationFn: (args: TArgs) => callMethod<TResult>(`mongomation.${method}`, args) });
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = React.useState(value);
  React.useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function useFailureSuggest(prefix: string) {
  const p = useDebounced(prefix.trim(), 150);
  return useQuery({
    queryKey: ['mongomation.suggestFailures', p],
    queryFn: () => callMethod<Envelope<FailureSuggestData>>('mongomation.suggestFailures', { prefix: p }, silent),
    enabled: p.length >= 2,
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });
}

export function useFailureSearch(query: string, filters: { sceneId?: string; faultId?: string }) {
  const q = query.trim();
  return useQuery({
    queryKey: ['mongomation.searchFailures', q, filters.sceneId, filters.faultId],
    queryFn: () => callMethod<Envelope<FailureSearchData>>('mongomation.searchFailures', { query: q, ...filters }, silent),
    enabled: q.length >= 2,
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });
}

export function useFailureFacets(query: string, filters: { sceneId?: string; faultId?: string }) {
  const q = query.trim();
  return useQuery({
    queryKey: ['mongomation.failureFacets', q, filters.sceneId, filters.faultId],
    queryFn: () =>
      callMethod<Envelope<FailureFacetsData>>(
        'mongomation.failureFacets',
        { ...(q.length >= 2 ? { query: q } : {}), ...filters },
        silent,
      ),
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });
}

// ---- live worker events (Modelence channel `mm-events`, id = projectId) ---------------------------------

const eventListeners = new Set<(m: LiveEventMessage) => void>();
let channel: ClientChannel<LiveEventMessage> | null = null;

function ensureChannel(): ClientChannel<LiveEventMessage> {
  if (channel) return channel;
  channel = new ClientChannel<LiveEventMessage>(EVENTS_CHANNEL, (m) => eventListeners.forEach((l) => l(m)));
  // Live queries may already have opened the Modelence websocket; otherwise open it with our channel.
  if (getWebsocketClientProvider()) channel.init();
  else startWebsockets({ channels: [channel] });
  return channel;
}

/** Newest-first worker events pushed for `projectId` since this component mounted. */
export function useLiveEvents(projectId: string | null, max = 8): { events: (EventLite & { receivedAt: number })[]; joined: boolean } {
  const [events, setEvents] = React.useState<(EventLite & { receivedAt: number })[]>([]);
  const [joined, setJoined] = React.useState(false);
  React.useEffect(() => {
    setEvents([]);
    if (!projectId) return;
    const ch = ensureChannel();
    const onMessage = (m: LiveEventMessage) => {
      if (m.projectId !== projectId) return;
      setEvents((prev) => [{ ...m.event, receivedAt: Date.now() }, ...prev.filter((e) => e.id !== m.event.id)].slice(0, max));
    };
    eventListeners.add(onMessage);
    ch.joinChannel(projectId);
    setJoined(true);
    // Socket.IO rooms do not survive a reconnect; re-joining is idempotent.
    const rejoin = window.setInterval(() => ch.joinChannel(projectId), 30_000);
    return () => {
      eventListeners.delete(onMessage);
      window.clearInterval(rejoin);
      ch.leaveChannel(projectId);
      setJoined(false);
    };
  }, [projectId, max]);
  return { events, joined };
}

// ---- AWS: presigned artifact links (plain read; URLs live 15 min) + rig health (live) ---------------------

export function useArtifactLinks(projectId: string | null, revision: string | undefined) {
  return useQuery({
    queryKey: ["mongomation.artifactLinks", projectId, revision],
    queryFn: () => callMethod<Envelope<ArtifactLinksData>>("mongomation.artifactLinks", { projectId }, silent),
    enabled: !!projectId,
    staleTime: 5 * 60_000,
    refetchInterval: 10 * 60_000,
  });
}

export function useRigAws() {
  return useQuery(modelenceLiveQuery<Envelope<RigAwsData>>("mongomation.liveRigAws"));
}
