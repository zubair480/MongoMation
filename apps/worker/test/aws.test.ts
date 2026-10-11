// AWS integration units with mocked SDK clients (no network, no credentials).
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { PutMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { CreateLogStreamCommand, PutLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { GetCommandInvocationCommand, GetParameterCommand, SendCommandCommand } from "@aws-sdk/client-ssm";
import { GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { StopInstancesCommand } from "@aws-sdk/client-ec2";
import { awsSettings, type Sender } from "../src/aws/config.ts";
import { artifactKey, presignGet, putArtifact } from "../src/aws/s3.ts";
import { jobMetricData, putMetrics, rigHealthMetricData } from "../src/aws/metrics.ts";
import { CloudWatchLogSink } from "../src/aws/logs.ts";
import { parseProbe, rigHealthy, runProbe, getSecureParameter } from "../src/aws/ssm.ts";
import { loadOpenPlcPassword, loadSecretIntoEnv } from "../src/aws/secrets.ts";
import { stopRig } from "../src/aws/ec2.ts";
import { compileLogText, publicTestResult, summarizeJob, testReport } from "../src/aws/report.ts";

/** Records every command; `reply` decides the response per command. */
function fake(reply: (cmd: any) => unknown = () => ({})): Sender & { sent: any[] } {
  const sent: any[] = [];
  return {
    sent,
    async send(cmd: any) {
      sent.push(cmd);
      const r = reply(cmd);
      if (r instanceof Error) throw r;
      return r;
    },
  };
}
const named = (name: string) => Object.assign(new Error(name), { name });

describe("aws config", () => {
  it("is fully off with an empty env and normalises the key prefix", () => {
    const c = awsSettings({});
    assert.equal(c.bucket, null);
    assert.equal(c.metrics, false);
    assert.equal(c.logGroup, null);
    assert.equal(c.rigHealth, false);
    assert.equal(c.region, "us-west-2");
    assert.equal(awsSettings({ MM_AWS_ARTIFACTS_PREFIX: "/demo" }).prefix, "demo/");
    assert.equal(awsSettings({ RIG_REGION: "eu-west-1" }).region, "eu-west-1");
    assert.equal(awsSettings({ MM_AWS_RIG_HEALTH_MS: "5" }).rigHealthMs, 30_000);
  });
});

describe("S3 artifacts", () => {
  it("uploads private, encrypted, checksummed objects and returns a Mongo-ready reference", async () => {
    const s3 = fake();
    const ref = await putArtifact(s3, { bucket: "b", key: artifactKey("runs/", "p1", "st", "v1 x.st"), body: "PROGRAM main END_PROGRAM", contentType: "text/plain", metadata: { kind: "st" } });
    assert.equal(ref.key, "runs/projects/p1/st/v1_x.st");
    assert.equal(ref.bytes, 24);
    assert.match(ref.sha256, /^[0-9a-f]{64}$/);
    const cmd = s3.sent[0];
    assert.ok(cmd instanceof PutObjectCommand);
    assert.equal(cmd.input.ServerSideEncryption, "AES256");
    assert.equal(cmd.input.Metadata?.project, "mongomation");
    assert.equal(cmd.input.ACL, undefined, "never sets a public ACL");
  });

  it("presigns a GET URL locally (no network) that expires", async () => {
    const s3 = new S3Client({ region: "us-west-2", credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "test-secret" } });
    const url = await presignGet(s3, "mongomation-artifacts", "runs/projects/p1/st/v1.st", 600);
    assert.match(url, /^https:\/\/mongomation-artifacts\.s3\.us-west-2\.amazonaws\.com\/runs\/projects\/p1\/st\/v1\.st\?/);
    assert.match(url, /X-Amz-Expires=600/);
  });
});

describe("CloudWatch metrics", () => {
  it("derives pass rates, repairs and duration from a job summary", () => {
    const data = jobMetricData({ jobType: "engineer", status: "completed", durationS: 42, compiles: { ok: 3, failed: 1 }, tests: { passed: 6, failed: 2, blocked: 1 }, repairs: 2 });
    const by = Object.fromEntries(data.map((d) => [d.MetricName, d.Value]));
    assert.equal(by.CompilePassRate, 75);
    assert.equal(by.TestPassRate, 75, "blocked tests are excluded from the pass rate");
    assert.equal(by.RepairAttempts, 2);
    assert.equal(by.JobDuration, 42);
    assert.equal(by.JobCompleted, 1);
    assert.ok(data.every((d) => d.Dimensions?.[0]?.Name === "JobType"));
  });

  it("omits rates when there was nothing to rate, and batches PutMetricData", async () => {
    const data = jobMetricData({ jobType: "evolve", status: "failed", durationS: null, compiles: { ok: 0, failed: 0 }, tests: { passed: 0, failed: 0, blocked: 0 }, repairs: 0 });
    assert.ok(!data.some((d) => d.MetricName === "CompilePassRate" || d.MetricName === "TestPassRate" || d.MetricName === "JobDuration"));
    const cw = fake();
    await putMetrics(cw, "MongoMation", Array.from({ length: 1001 }, () => data[0]));
    assert.equal(cw.sent.length, 3);
    assert.ok(cw.sent[0] instanceof PutMetricDataCommand);
    assert.equal(cw.sent[0].input.Namespace, "MongoMation");
  });

  it("emits RigHealthy plus one RigCheckOk per check", () => {
    const data = rigHealthMetricData("rig-1", false, { "openplc.openplcProcess": true, "openplc.modbusListening": false });
    assert.equal(data[0].MetricName, "RigHealthy");
    assert.equal(data[0].Value, 0);
    assert.equal(data.length, 3);
  });
});

describe("CloudWatch Logs sink", () => {
  it("creates the stream once (tolerating 'already exists') and ships JSON events", async () => {
    const logs = fake((c) => (c instanceof CreateLogStreamCommand ? named("ResourceAlreadyExistsException") : {}));
    const sink = new CloudWatchLogSink(logs, "/mongomation/worker", "w1");
    sink.emit("job_finished", { jobId: "j1", status: "completed" });
    await sink.flush();
    sink.emit("rig_health", { healthy: true });
    await sink.flush();
    assert.equal(logs.sent.filter((c) => c instanceof CreateLogStreamCommand).length, 1);
    const puts = logs.sent.filter((c) => c instanceof PutLogEventsCommand);
    assert.equal(puts.length, 2);
    assert.deepEqual(JSON.parse(String(puts[0].input.logEvents?.[0]?.message)),{ event: "job_finished", jobId: "j1", status: "completed" });
  });

  it("never throws when AWS rejects the write; warns once", async () => {
    const warnings: string[] = [];
    const sink = new CloudWatchLogSink(fake(() => named("AccessDeniedException")), "g", "s", (m) => warnings.push(m));
    sink.emit("a");
    await sink.flush();
    sink.emit("b");
    await sink.flush();
    assert.equal(warnings.length, 1);
  });
});

describe("SSM", () => {
  it("GetParameter uses WithDecryption and treats 'None' as missing", async () => {
    const ssm = fake((c) => ({ Parameter: { Value: c.input.Name === "/x" ? "s3cret" : "None" } }));
    assert.equal(await getSecureParameter(ssm, "/x"), "s3cret");
    assert.equal(await getSecureParameter(ssm, "/y"), null);
    assert.ok(ssm.sent[0] instanceof GetParameterCommand);
    assert.equal(ssm.sent[0].input.WithDecryption, true);
  });

  it("loads OPENPLC_PASSWORD only when unset", async () => {
    const ssm = fake(() => ({ Parameter: { Value: "pw" } }));
    const env: NodeJS.ProcessEnv = {};
    assert.equal(await loadOpenPlcPassword(ssm, "/autominus/openplc-api-password", env), "loaded");
    assert.equal(env.OPENPLC_PASSWORD, "pw");
    assert.equal(await loadOpenPlcPassword(ssm, "/p", { OPENPLC_PASSWORD: "local" }), "already_set");
    assert.equal(ssm.sent.length, 1);
  });

  it("runs the read-only probe via Run Command, polls until done and parses the JSON line", async () => {
    let polls = 0;
    const out = '{"openplcProcess":true,"openplcApiListening":true,"modbusListening":true,"openplcContainer":false,"load1":0.12,"memAvailableMb":812,"diskUsedPct":41,"uptimeS":3600}';
    const ssm = fake((c) => {
      if (c instanceof SendCommandCommand) return { Command: { CommandId: "cmd-1" } };
      if (c instanceof GetCommandInvocationCommand) return ++polls === 1 ? named("InvocationDoesNotExist") : polls === 2 ? { Status: "InProgress" } : { Status: "Success", StandardOutputContent: `banner\n${out}\n` };
      return {};
    });
    const r = await runProbe(ssm, { instanceId: "i-0abc", platform: "linux", sleep: async () => {} });
    assert.equal(ssm.sent[0].input.DocumentName, "AWS-RunShellScript");
    assert.deepEqual(ssm.sent[0].input.InstanceIds, ["i-0abc"]);
    assert.equal(r.ok, true);
    assert.equal(r.checks.modbusListening, true);
    assert.equal(r.stats.memAvailableMb, 812);
    assert.equal(rigHealthy([r]), true, "openplcContainer is optional");
    assert.equal(rigHealthy([parseProbe("Success", '{"openplcProcess":false}')]), false);
    assert.equal(rigHealthy([parseProbe("Failed", "")]), false);
    assert.equal(rigHealthy([]), false);
  });
});

describe("Secrets Manager", () => {
  it("fills only unset, well-formed env names and never returns values", async () => {
    const sm = fake(() => ({ SecretString: JSON.stringify({ MONGODB_URI: "mongodb+srv://x", TEAM_API_KEY: "k", "bad-name": "v", EMPTY: "" }) }));
    const env: NodeJS.ProcessEnv = { TEAM_API_KEY: "already" };
    const set = await loadSecretIntoEnv(sm, "mongomation/worker", env);
    assert.ok(sm.sent[0] instanceof GetSecretValueCommand);
    assert.deepEqual(set, ["MONGODB_URI"]);
    assert.equal(env.TEAM_API_KEY, "already");
    assert.equal(env["bad-name"], undefined);
  });
});

describe("EC2 rig power", () => {
  it("maps a DryRun success to 'permitted' and reports state transitions", async () => {
    const dry = fake(() => named("DryRunOperation"));
    assert.equal(await stopRig(dry, "i-0abc", true), "dry-run: permitted");
    assert.ok(dry.sent[0] instanceof StopInstancesCommand);
    assert.equal(dry.sent[0].input.DryRun, true);
    const real = fake(() => ({ StoppingInstances: [{ PreviousState: { Name: "running" }, CurrentState: { Name: "stopping" } }] }));
    assert.equal(await stopRig(real, "i-0abc"), "running -> stopping");
    await assert.rejects(stopRig(fake(() => named("UnauthorizedOperation")), "i-0abc", true));
  });
});

describe("artifact reports", () => {
  it("strips hidden test steps and step logs from exported reports", () => {
    const hidden = publicTestResult({ _id: "t1", testId: "H1", visibility: "hidden", verdict: "passed", steps: [1], stepLogs: ["x"] });
    assert.equal(hidden.steps, undefined);
    assert.equal(hidden.stepLogs, undefined);
    const pub = publicTestResult({ _id: "t2", visibility: "public", steps: [1], stepLogs: ["y"] });
    assert.equal(pub.steps, undefined);
    assert.deepEqual(pub.stepLogs, ["y"]);
    const rep = JSON.parse(testReport({ _id: "r1", passed: 1 }, [{ _id: "t1", visibility: "hidden", steps: [1] }]));
    assert.equal(rep.simRunId, "r1");
    assert.equal(rep.results[0].steps, undefined);
  });

  it("formats compile logs and summarises a job window", () => {
    assert.match(compileLogText({ _id: "c1", stage: "compile", toolchain: "OpenPLC", ok: false, log: "ERR line 3", createdAt: new Date(0) }), /result: failed[\s\S]*ERR line 3$/);
    const t0 = new Date("2026-10-11T10:00:00Z");
    const s = summarizeJob(
      { type: "engineer", status: "completed", startedAt: t0, finishedAt: new Date(t0.getTime() + 90_000) },
      [{ stage: "preflight", status: "ok" }, { stage: "compile", ok: false }, { stage: "compile", ok: true }],
      [{ passed: 3, failed: 1, blocked: 0 }, { passed: 4, failed: 0, blocked: 1 }],
      [{}],
    );
    assert.deepEqual(s, { jobType: "engineer", status: "completed", durationS: 90, compiles: { ok: 1, failed: 1 }, tests: { passed: 7, failed: 1, blocked: 1 }, repairs: 1 });
  });
});

describe("CloudFormation template (infra/aws/template.ts)", async () => {
  const { buildTemplate } = await import("../../../infra/aws/template.ts");
  const { LINUX_PROBE } = await import("../src/aws/ssm.ts");
  const t = buildTemplate() as any;
  const res = Object.entries(t.Resources) as [string, any][];

  it("creates nothing expensive and never manages EC2 instances / networking", () => {
    const types = new Set(res.map(([, r]) => r.Type));
    for (const bad of ["AWS::EC2::Instance", "AWS::EC2::NatGateway", "AWS::RDS::DBInstance", "AWS::EC2::SecurityGroup", "AWS::EC2::VPC"]) assert.ok(!types.has(bad), bad);
  });

  it("tags every taggable resource project=mongomation", () => {
    const untaggable = new Set(["AWS::S3::BucketPolicy", "AWS::Logs::MetricFilter", "AWS::CloudWatch::Dashboard", "AWS::Scheduler::Schedule", "AWS::IAM::ManagedPolicy"]);
    for (const [name, r] of res) if (!untaggable.has(r.Type)) assert.deepEqual(r.Properties.Tags, [{ Key: "project", Value: { Ref: "ProjectTag" } }], name);
  });

  it("locks the bucket down and expires artifacts", () => {
    const b = t.Resources.ArtifactsBucket.Properties;
    assert.deepEqual(Object.values(b.PublicAccessBlockConfiguration), [true, true, true, true]);
    assert.equal(b.LifecycleConfiguration.Rules[0].ExpirationInDays.Ref, "ArtifactRetentionDays");
    assert.equal(b.BucketEncryption.ServerSideEncryptionConfiguration[0].ServerSideEncryptionByDefault.SSEAlgorithm, "AES256");
  });

  it("ships the rig probe schedule and the rig stop/start schedules DISABLED by default", () => {
    assert.equal(t.Parameters.HealthProbeState.Default, "DISABLED");
    assert.equal(t.Parameters.RigPowerScheduleState.Default, "DISABLED");
    assert.equal(t.Resources.RigStopSchedule.Properties.State.Ref, "RigPowerScheduleState");
  });

  it("uses the same read-only probe script as the worker, without SSM {{ }} placeholders", () => {
    const cmds = t.Resources.RigHealthProbeDocument.Properties.Content.mainSteps[0].inputs.runCommand;
    assert.deepEqual(cmds, LINUX_PROBE);
    assert.ok(!cmds.join("\n").includes("{{"));
  });
});
