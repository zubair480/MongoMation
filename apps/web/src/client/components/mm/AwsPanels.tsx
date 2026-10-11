import { Cloud, Download, FileCode2, FileText, ScrollText, ServerCog } from 'lucide-react';
import type { ArtifactLink } from '@/shared/insights';
import { cn } from '@/client/lib/utils';
import { fmtAge } from '@/client/lib/format';
import { useArtifactLinks, useRigAws } from '@/client/lib/insights';
import { receivedAtOf } from '@/client/lib/api';
import { Panel, SectionLabel, StatusPill, Tip, useLiveAge } from './ui';

function kb(bytes: number | undefined) {
  if (bytes === undefined) return '';
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
}

function LinkRow({ link, icon, title }: { link: ArtifactLink | null; icon: React.ReactNode; title: string }) {
  if (!link) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-dashed border-plant-700 px-2.5 py-1.5 text-[12px] text-plant-500">
        <span className="[&_svg]:size-3.5">{icon}</span>
        {title}
        <span className="ml-auto font-mono text-[10px] uppercase tracking-wider">not archived</span>
      </div>
    );
  }
  const body = (
    <>
      <span className="[&_svg]:size-3.5">{icon}</span>
      <span className="truncate">Download {link.label === title ? title : `${title} · ${link.label}`}</span>
      <span className="ml-auto shrink-0 font-mono text-[10px] text-plant-400">{kb(link.bytes)}</span>
      <Download className="size-3.5 shrink-0" aria-hidden />
    </>
  );
  return link.url ? (
    <a
      href={link.url}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-2 rounded-md border border-flow-500/50 bg-flow-500/[0.07] px-2.5 py-1.5 text-[12px] text-flow-300 transition-colors hover:bg-flow-500/15"
    >
      {body}
    </a>
  ) : (
    <Tip tip={`s3 key ${link.key}${link.sha256 ? ` · sha256 ${link.sha256.slice(0, 12)}…` : ''} · presigning is off on this server (no AWS credentials)`} className="w-full">
      <span className="flex w-full items-center gap-2 rounded-md border border-plant-700 px-2.5 py-1.5 text-[12px] text-plant-400">{body}</span>
    </Tip>
  );
}

/** S3 run artifacts of the selected project (ST, compile log, public test report, job record). */
export function ArtifactsCard({ projectId, revision }: { projectId: string | null; revision?: string }) {
  const q = useArtifactLinks(projectId, revision);
  const data = q.data?.connected ? q.data : null;
  if (!projectId) return null;
  return (
    <Panel
      title="Run artifacts · S3"
      icon={<Cloud />}
      right={
        data ? (
          <StatusPill tone={data.s3Configured ? 'good' : 'muted'}>{data.s3Configured ? `presigned · ${data.ttlSeconds / 60} min` : 'presign off'}</StatusPill>
        ) : undefined
      }
    >
      {q.data && !q.data.connected ? (
        <p className="font-mono text-[11px] text-stop-300">{q.data.error}</p>
      ) : !data ? (
        <p className="font-mono text-[11px] text-plant-500">Loading artifact references…</p>
      ) : (
        <div className="space-y-1.5">
          <LinkRow link={data.links.st} icon={<FileCode2 />} title="ST" />
          <LinkRow link={data.links.compileLog} icon={<ScrollText />} title="Compile log" />
          <LinkRow link={data.links.testReport} icon={<FileText />} title="Test report" />
          <LinkRow link={data.links.jobRecord} icon={<FileText />} title="Job record" />
          <p className="pt-1 font-mono text-[10px] text-plant-500">
            References read from Atlas ({'{bucket, key, bytes, sha256}'}); measurement archives are withheld because they include hidden tests.
          </p>
        </div>
      )}
    </Panel>
  );
}

/** rig_status.aws: the worker's SSM Run Command health probe of the rig hosts. Rendered inside the rig panel. */
export function RigAwsHealth() {
  const q = useRigAws();
  const aws = q.data?.connected ? q.data.aws : null;
  const age = useLiveAge(aws?.ageMs, receivedAtOf(q));
  if (!q.data?.connected) return null;
  return (
    <div>
      <SectionLabel
        right={
          aws ? (
            <StatusPill tone={aws.healthy === undefined ? 'muted' : aws.healthy ? 'good' : 'bad'}>
              {aws.healthy === undefined ? 'unknown' : aws.healthy ? 'healthy' : 'unhealthy'} · {fmtAge(age)}
            </StatusPill>
          ) : undefined
        }
      >
        <span className="inline-flex items-center gap-1.5">
          <ServerCog className="size-3.5" aria-hidden /> Rig hosts · AWS SSM
        </span>
      </SectionLabel>
      {!aws ? (
        <p className="rounded-md border border-dashed border-plant-700 px-2.5 py-2 font-mono text-[10.5px] text-plant-500">
          No AWS health probe yet (worker MM_AWS_RIG_HEALTH off)
        </p>
      ) : (
        <div className="space-y-1.5">
          {aws.hosts.map((h) => (
            <div key={h.role} className="rounded-md border border-plant-700 bg-plant-900/60 px-2.5 py-1.5">
              <div className="flex items-center justify-between gap-2 text-[12px]">
                <span className="font-mono text-plant-100">{h.role}</span>
                <StatusPill tone={h.ok === undefined ? 'muted' : h.ok ? 'good' : 'bad'}>{h.status ?? (h.ok ? 'ok' : 'failed')}</StatusPill>
              </div>
              {h.checks.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {h.checks.map((c) => (
                    <span
                      key={c.name}
                      className={cn(
                        'rounded border px-1 py-px font-mono text-[10px]',
                        c.ok === null ? 'border-plant-700 text-plant-400' : c.ok ? 'border-go-500/40 text-go-300' : 'border-stop-500/50 text-stop-300',
                      )}
                    >
                      {c.name}
                    </span>
                  ))}
                </div>
              )}
              {h.detail && !h.ok && <p className="mt-1 break-words font-mono text-[10.5px] text-plant-400">{h.detail}</p>}
            </div>
          ))}
          {aws.via && <p className="font-mono text-[10px] text-plant-500">via {aws.via}</p>}
        </div>
      )}
    </div>
  );
}
