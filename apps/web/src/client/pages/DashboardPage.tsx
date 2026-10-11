import * as React from 'react';
import { useSearchParams } from 'react-router';
import { useSession } from 'modelence/client';
import { receivedAtOf, useAblation, useDashboard, useProject, useRsi, useScenes } from '@/client/lib/api';
import { Seo } from '@/client/components/Seo';
import { HeaderBar } from '@/client/components/mm/HeaderBar';
import { SpecConsole } from '@/client/components/mm/SpecConsole';
import { ProjectPicker } from '@/client/components/mm/ProjectPicker';
import { SimulationPanel } from '@/client/components/mm/SimulationPanel';
import { ExecutionPanel } from '@/client/components/mm/ExecutionPanel';
import { ResultsCard } from '@/client/components/mm/ResultsCard';
import { RsiCard } from '@/client/components/mm/RsiCard';
import { AblationCard } from '@/client/components/mm/AblationCard';
import { LongHorizonCard } from '@/client/components/mm/LongHorizonCard';
import { DisconnectedNotice, EmptyState, Loading, ServerUnreachable } from '@/client/components/mm/ui';
import type { Envelope } from '@/shared/mongomation';

/** Placeholder while a query has no usable data (loading / server unreachable / Atlas disconnected); null once it has. */
function placeholderFor(q: { data?: Envelope<unknown>; isError: boolean; error: unknown }, what: string): React.ReactNode | null {
  if (!q.data && q.isError) return <ServerUnreachable error={q.error} what={what} />;
  if (!q.data) return <Loading label={`Loading ${what}`} />;
  if (!q.data.connected) return <DisconnectedNotice status={q.data} what={what} />;
  return null;
}

export default function DashboardPage() {
  const { user } = useSession();
  const [searchParams, setSearchParams] = useSearchParams();
  const pinnedProjectId = searchParams.get('project');

  const dashboardQ = useDashboard();
  const scenesQ = useScenes();
  const rsiQ = useRsi();
  const ablationQ = useAblation();

  const dash = dashboardQ.data?.connected ? dashboardQ.data : null;
  const dashReceivedAt = receivedAtOf(dashboardQ);
  const dashDisconnected = dashboardQ.data && !dashboardQ.data.connected ? dashboardQ.data : null;
  const scenesData = scenesQ.data?.connected ? scenesQ.data : null;
  const scenes = scenesData?.scenes ?? [];

  // Follow the newest project unless one is pinned in the URL (?project=<id>).
  const selectedProjectId = pinnedProjectId ?? dash?.projects[0]?.id ?? null;
  const projectQ = useProject(selectedProjectId);
  const projectData = projectQ.data?.connected ? projectQ.data : null;
  const project = projectData?.project ?? null;
  const projectScene = project?.sceneId ? scenes.find((s) => s.id === project.sceneId) : undefined;

  const selectProject = React.useCallback(
    (id: string) =>
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current);
          next.set('project', id);
          return next;
        },
        { replace: true }
      ),
    [setSearchParams]
  );
  const followLatest = React.useCallback(
    () =>
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current);
          next.delete('project');
          return next;
        },
        { replace: true }
      ),
    [setSearchParams]
  );

  // Without a connected dashboard answer we cannot know whether runs exist, so never claim "No runs yet".
  const dashPlaceholder = placeholderFor(dashboardQ, 'dashboard');
  const projectPlaceholder = selectedProjectId ? placeholderFor(projectQ, 'project') : dashPlaceholder;
  const rsiPlaceholder = placeholderFor(rsiQ, 'harness versions');
  const ablationPlaceholder = placeholderFor(ablationQ, 'ablation results');

  return (
    <div className="min-h-screen bg-blueprint text-plant-100">
      <Seo title="Live engineering dashboard" />
      <HeaderBar dashboardQ={dashboardQ} />

      <main className="mx-auto max-w-[1800px] space-y-4 px-4 pb-12 pt-4 lg:px-6">
        {dashDisconnected && (
          <div className="animate-rise">
            <DisconnectedNotice status={dashDisconnected} what="MongoDB Atlas · showing no data until the connection works" />
          </div>
        )}
        {dashboardQ.isError && (
          <ServerUnreachable
            error={dashboardQ.error}
            what={dashboardQ.data ? 'values below are the last answer received; ages keep counting' : 'dashboard'}
          />
        )}

        <SpecConsole
          connected={!!dash && !!scenesData}
          scenesStatus={scenesData ? 'ready' : scenesQ.data || scenesQ.isError ? 'unavailable' : 'loading'}
          scenes={scenes}
          examples={scenesData?.examples ?? []}
          dash={dash}
          receivedAt={dashReceivedAt}
          project={project}
          projectId={selectedProjectId}
          signedIn={!!user}
        />

        {dash ? (
          <ProjectPicker
            projects={dash.projects}
            selectedId={selectedProjectId}
            pinned={!!pinnedProjectId}
            onSelect={selectProject}
            onFollowLatest={followLatest}
          />
        ) : null}

        <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2 xl:grid-cols-[minmax(0,0.85fr)_minmax(0,1.1fr)_minmax(0,1.25fr)]">
          <SimulationPanel
            disconnected={dashDisconnected}
            rig={dash?.rig ?? null}
            receivedAt={dashReceivedAt}
            scenes={scenes}
            selectedProjectSceneId={project?.sceneId}
            faults={projectData?.faults ?? []}
          />

          <ExecutionPanel
            projectId={selectedProjectId}
            project={project}
            stages={projectData?.stages ?? []}
            events={projectData?.events ?? []}
            receivedAt={receivedAtOf(projectQ)}
          >
            {projectPlaceholder ?? undefined}
          </ExecutionPanel>

          <div className="space-y-4 lg:col-span-2 xl:col-span-1">
            <ResultsCard data={projectData} sceneTags={projectScene?.tags ?? []}>
              {projectPlaceholder ??
                (selectedProjectId ? undefined : <EmptyState>No runs yet · results appear after the first engineering run</EmptyState>)}
            </ResultsCard>
            <RsiCard data={rsiQ.data?.connected ? rsiQ.data : null}>{rsiPlaceholder ?? undefined}</RsiCard>
            <AblationCard data={ablationQ.data?.connected ? ablationQ.data : null}>{ablationPlaceholder ?? undefined}</AblationCard>
            <LongHorizonCard dash={dash} receivedAt={dashReceivedAt} signedIn={!!user}>
              {dashPlaceholder ?? undefined}
            </LongHorizonCard>
          </div>
        </div>

        <footer className="pt-2 text-center font-mono text-[10.5px] text-plant-500">
          Every value on this page is read from MongoDB Atlas{dash ? ` (${dash.db})` : ''}; the dashboard only writes job requests.
        </footer>
      </main>
    </div>
  );
}
