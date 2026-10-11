// CloudFormation for MongoMation's cheap AWS footprint (no EC2 / NAT / RDS; the existing rig is only REFERENCED):
//   S3 artifacts bucket (block-public-access, SSE-S3, TLS-only, lifecycle expiry) - CloudWatch log groups -
//   rig-unhealthy alarms (+ optional SNS email) - CloudWatch dashboard - SSM document for the read-only rig probe -
//   EventBridge Scheduler: scheduled rig probe (SSM Run Command -> Logs -> metric filter) and rig stop/start for
//   cost control (both DISABLED by default) - optional Secrets Manager secret - least-privilege worker IAM policy.
// Everything is tagged project=mongomation.
//
// Render:  npx tsx infra/aws/template.ts > infra/aws/mongomation.template.json
// Deploy:  bash infra/aws/deploy.sh          (wraps `aws cloudformation deploy`; see its header)
import { LINUX_PROBE } from "../../apps/worker/src/aws/ssm.ts";

const sub = (s: string) => ({ "Fn::Sub": s });
const ref = (r: string) => ({ Ref: r });
const ifc = (c: string, a: unknown, b: unknown) => ({ "Fn::If": [c, a, b] });
const NOVALUE = { Ref: "AWS::NoValue" };
const TAGS = [{ Key: "project", Value: ref("ProjectTag") }];
const instanceArn = (p: string) => sub(`arn:\${AWS::Partition}:ec2:\${AWS::Region}:\${AWS::AccountId}:instance/\${${p}}`);

export function buildTemplate() {
  return {
    AWSTemplateFormatVersion: "2010-09-09",
    Description: "MongoMation: S3 run artifacts, CloudWatch metrics/logs/alarms, SSM rig probe, Scheduler rig cost control (project=mongomation)",
    Parameters: {
      ProjectTag: { Type: "String", Default: "mongomation" },
      ArtifactsBucketName: { Type: "String", Default: "", Description: "Leave empty for a generated name" },
      ArtifactsPrefix: { Type: "String", Default: "runs/" },
      ArtifactRetentionDays: { Type: "Number", Default: 30, MinValue: 1 },
      LogRetentionDays: { Type: "Number", Default: 14, AllowedValues: [1, 3, 5, 7, 14, 30, 60, 90] },
      MetricsNamespace: { Type: "String", Default: "MongoMation" },
      RigId: { Type: "String", Default: "rig-1", Description: "RIG_ID used as the Rig metric dimension" },
      RigInstanceId: { Type: "String", Default: "", Description: "Existing Linux OpenPLC rig instance (referenced, never modified by this stack)" },
      FioInstanceId: { Type: "String", Default: "", Description: "Optional Windows Factory I/O instance (for worker IAM only)" },
      OpenPlcPasswordParam: { Type: "String", Default: "/autominus/openplc-api-password" },
      AlarmEmail: { Type: "String", Default: "", Description: "Optional: email subscribed to rig alarms (confirm the SNS mail)" },
      AlarmMissingData: { Type: "String", Default: "missing", AllowedValues: ["missing", "breaching", "notBreaching", "ignore"] },
      HealthProbeState: { Type: "String", Default: "DISABLED", AllowedValues: ["ENABLED", "DISABLED"] },
      HealthProbeRate: { Type: "String", Default: "rate(5 minutes)" },
      RigPowerScheduleState: { Type: "String", Default: "DISABLED", AllowedValues: ["ENABLED", "DISABLED"] },
      RigStopCron: { Type: "String", Default: "cron(0 1 * * ? *)" },
      RigStartCron: { Type: "String", Default: "cron(0 8 * * ? *)" },
      ScheduleTimezone: { Type: "String", Default: "America/Los_Angeles" },
      CreateWorkerSecret: { Type: "String", Default: "false", AllowedValues: ["true", "false"], Description: "Secrets Manager secret mongomation/worker (~$0.40/month)" },
    },
    Conditions: {
      NamedBucket: { "Fn::Not": [{ "Fn::Equals": [ref("ArtifactsBucketName"), ""] }] },
      HasRig: { "Fn::Not": [{ "Fn::Equals": [ref("RigInstanceId"), ""] }] },
      HasFio: { "Fn::Not": [{ "Fn::Equals": [ref("FioInstanceId"), ""] }] },
      HasEmail: { "Fn::Not": [{ "Fn::Equals": [ref("AlarmEmail"), ""] }] },
      WantSecret: { "Fn::Equals": [ref("CreateWorkerSecret"), "true"] },
    },
    Resources: {
      ArtifactsBucket: {
        Type: "AWS::S3::Bucket",
        DeletionPolicy: "Retain",
        UpdateReplacePolicy: "Retain",
        Properties: {
          BucketName: ifc("NamedBucket", ref("ArtifactsBucketName"), NOVALUE),
          PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
          OwnershipControls: { Rules: [{ ObjectOwnership: "BucketOwnerEnforced" }] },
          BucketEncryption: { ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" }, BucketKeyEnabled: true }] },
          LifecycleConfiguration: {
            Rules: [
              { Id: "expire-run-artifacts", Status: "Enabled", Prefix: ref("ArtifactsPrefix"), ExpirationInDays: ref("ArtifactRetentionDays"), AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 } },
              { Id: "abort-incomplete-uploads", Status: "Enabled", Prefix: "", AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 } },
            ],
          },
          CorsConfiguration: { CorsRules: [{ AllowedMethods: ["GET", "HEAD"], AllowedOrigins: ["*"], AllowedHeaders: ["*"], MaxAge: 3600 }] },
          Tags: TAGS,
        },
      },
      ArtifactsBucketPolicy: {
        Type: "AWS::S3::BucketPolicy",
        Properties: {
          Bucket: ref("ArtifactsBucket"),
          PolicyDocument: {
            Version: "2012-10-17",
            Statement: [
              {
                Sid: "DenyInsecureTransport",
                Effect: "Deny",
                Principal: "*",
                Action: "s3:*",
                Resource: [{ "Fn::GetAtt": ["ArtifactsBucket", "Arn"] }, sub("${ArtifactsBucket.Arn}/*")],
                Condition: { Bool: { "aws:SecureTransport": "false" } },
              },
            ],
          },
        },
      },
      WorkerLogGroup: { Type: "AWS::Logs::LogGroup", Properties: { LogGroupName: "/mongomation/worker", RetentionInDays: ref("LogRetentionDays"), Tags: TAGS } },
      RigProbeLogGroup: { Type: "AWS::Logs::LogGroup", Properties: { LogGroupName: "/mongomation/rig-health", RetentionInDays: ref("LogRetentionDays"), Tags: TAGS } },
      // SSM Run Command writes the probe's stdout (one JSON line) here; this filter turns a fully healthy line into a metric.
      RigProbeHealthyFilter: {
        Type: "AWS::Logs::MetricFilter",
        Properties: {
          LogGroupName: ref("RigProbeLogGroup"),
          FilterPattern: "{ ($.openplcProcess IS TRUE) && ($.openplcApiListening IS TRUE) && ($.modbusListening IS TRUE) }",
          MetricTransformations: [{ MetricNamespace: ref("MetricsNamespace"), MetricName: "ScheduledProbeHealthy", MetricValue: "1", DefaultValue: 0, Unit: "Count" }],
        },
      },
      RigHealthProbeDocument: {
        Type: "AWS::SSM::Document",
        Properties: {
          DocumentType: "Command",
          DocumentFormat: "JSON",
          Name: "MongoMation-RigHealthProbe",
          UpdateMethod: "NewVersion",
          Tags: TAGS,
          Content: {
            schemaVersion: "2.2",
            description: "MongoMation read-only rig probe: OpenPLC process, API :8443, Modbus :502, load/mem/disk. Prints one JSON line.",
            mainSteps: [{ action: "aws:runShellScript", name: "probe", precondition: { StringEquals: ["platformType", "Linux"] }, inputs: { timeoutSeconds: "30", runCommand: LINUX_PROBE } }],
          },
        },
      },
      AlarmTopic: { Type: "AWS::SNS::Topic", Condition: "HasEmail", Properties: { TopicName: "mongomation-alarms", Subscription: [{ Protocol: "email", Endpoint: ref("AlarmEmail") }], Tags: TAGS } },
      // Fed by the worker (MM_AWS_RIG_HEALTH=1): RigHealthy{Rig} = 1 when every rig check passed.
      RigUnhealthyAlarm: {
        Type: "AWS::CloudWatch::Alarm",
        Properties: {
          AlarmName: "mongomation-rig-unhealthy",
          AlarmDescription: "Worker SSM probe: OpenPLC process / API / Modbus port not healthy for 2 consecutive 5-minute periods",
          Namespace: ref("MetricsNamespace"),
          MetricName: "RigHealthy",
          Dimensions: [{ Name: "Rig", Value: ref("RigId") }],
          Statistic: "Minimum",
          Period: 300,
          EvaluationPeriods: 2,
          Threshold: 1,
          ComparisonOperator: "LessThanThreshold",
          TreatMissingData: ref("AlarmMissingData"),
          AlarmActions: ifc("HasEmail", [ref("AlarmTopic")], NOVALUE),
          OKActions: ifc("HasEmail", [ref("AlarmTopic")], NOVALUE),
          Tags: TAGS,
        },
      },
      // Fed by the scheduled probe (independent of the worker): no healthy probe line in 15 minutes.
      ScheduledProbeUnhealthyAlarm: {
        Type: "AWS::CloudWatch::Alarm",
        Condition: "HasRig",
        Properties: {
          AlarmName: "mongomation-rig-probe-unhealthy",
          AlarmDescription: "Scheduled SSM probe produced no fully healthy result in 15 minutes (only meaningful while HealthProbeState=ENABLED)",
          Namespace: ref("MetricsNamespace"),
          MetricName: "ScheduledProbeHealthy",
          Statistic: "Sum",
          Period: 900,
          EvaluationPeriods: 1,
          Threshold: 1,
          ComparisonOperator: "LessThanThreshold",
          TreatMissingData: ref("AlarmMissingData"),
          AlarmActions: ifc("HasEmail", [ref("AlarmTopic")], NOVALUE),
          Tags: TAGS,
        },
      },
      Dashboard: {
        Type: "AWS::CloudWatch::Dashboard",
        Properties: {
          DashboardName: "MongoMation",
          DashboardBody: sub(
            JSON.stringify({
              widgets: [
                metricWidget(0, "Compile / test pass rate (%)", [["${MetricsNamespace}", "CompilePassRate", "JobType", "engineer"], [".", "TestPassRate", ".", "."]], "Average"),
                metricWidget(12, "Repair attempts / job duration (s)", [["${MetricsNamespace}", "RepairAttempts", "JobType", "engineer", { stat: "Sum" }], [".", "JobDuration", ".", ".", { yAxis: "right" }]], "Average"),
                metricWidget(0, "Jobs completed / failed / blocked", [["${MetricsNamespace}", "JobCompleted", "JobType", "engineer"], [".", "JobFailed", ".", "."], [".", "JobBlocked", ".", "."]], "Sum", 6),
                metricWidget(12, "Rig healthy (worker probe)", [["${MetricsNamespace}", "RigHealthy", "Rig", "${RigId}"], [".", "ScheduledProbeHealthy"]], "Minimum", 6),
              ],
            }),
          ),
        },
      },
      SchedulerGroup: { Type: "AWS::Scheduler::ScheduleGroup", Properties: { Name: "mongomation", Tags: TAGS } },
      SchedulerRole: {
        Type: "AWS::IAM::Role",
        Condition: "HasRig",
        Properties: {
          AssumeRolePolicyDocument: {
            Version: "2012-10-17",
            Statement: [{ Effect: "Allow", Principal: { Service: "scheduler.amazonaws.com" }, Action: "sts:AssumeRole", Condition: { StringEquals: { "aws:SourceAccount": ref("AWS::AccountId") } } }],
          },
          Policies: [
            {
              PolicyName: "rig-power-and-probe",
              PolicyDocument: {
                Version: "2012-10-17",
                Statement: [
                  { Effect: "Allow", Action: ["ec2:StartInstances", "ec2:StopInstances"], Resource: instanceArn("RigInstanceId") },
                  { Effect: "Allow", Action: "ssm:SendCommand", Resource: [instanceArn("RigInstanceId"), sub("arn:${AWS::Partition}:ssm:${AWS::Region}:${AWS::AccountId}:document/${RigHealthProbeDocument}")] },
                ],
              },
            },
          ],
          Tags: TAGS,
        },
      },
      RigHealthProbeSchedule: {
        Type: "AWS::Scheduler::Schedule",
        Condition: "HasRig",
        Properties: {
          Name: "mongomation-rig-health-probe",
          GroupName: ref("SchedulerGroup"),
          Description: "Read-only SSM Run Command probe of the rig; output -> /mongomation/rig-health -> ScheduledProbeHealthy metric",
          State: ref("HealthProbeState"),
          ScheduleExpression: ref("HealthProbeRate"),
          FlexibleTimeWindow: { Mode: "OFF" },
          Target: {
            Arn: sub("arn:${AWS::Partition}:scheduler:::aws-sdk:ssm:sendCommand"),
            RoleArn: { "Fn::GetAtt": ["SchedulerRole", "Arn"] },
            Input: sub(JSON.stringify({ DocumentName: "${RigHealthProbeDocument}", InstanceIds: ["${RigInstanceId}"], CloudWatchOutputConfig: { CloudWatchOutputEnabled: true, CloudWatchLogGroupName: "${RigProbeLogGroup}" } })),
            RetryPolicy: { MaximumRetryAttempts: 0 },
          },
        },
      },
      RigStopSchedule: powerSchedule("stop", "RigStopCron", "Nightly rig stop for cost control (DISABLED unless RigPowerScheduleState=ENABLED)"),
      RigStartSchedule: powerSchedule("start", "RigStartCron", "Morning rig start (DISABLED unless RigPowerScheduleState=ENABLED)"),
      WorkerSecret: {
        Type: "AWS::SecretsManager::Secret",
        Condition: "WantSecret",
        Properties: {
          Name: "mongomation/worker",
          Description: "JSON object of worker env vars (MONGODB_URI, TEAM_API_KEY, RAINDROP_WRITE_KEY, ...). Read by MM_AWS_SECRETS_ID; only fills unset vars.",
          SecretString: "{}",
          Tags: TAGS,
        },
      },
      WorkerPolicy: {
        Type: "AWS::IAM::ManagedPolicy",
        Properties: {
          ManagedPolicyName: "mongomation-worker",
          Description: "Least privilege for the MongoMation worker's MM_AWS_* features",
          PolicyDocument: {
            Version: "2012-10-17",
            Statement: [
              { Sid: "Artifacts", Effect: "Allow", Action: ["s3:PutObject", "s3:GetObject"], Resource: sub("${ArtifactsBucket.Arn}/*") },
              { Sid: "Metrics", Effect: "Allow", Action: "cloudwatch:PutMetricData", Resource: "*", Condition: { StringEquals: { "cloudwatch:namespace": ref("MetricsNamespace") } } },
              { Sid: "Logs", Effect: "Allow", Action: ["logs:CreateLogStream", "logs:PutLogEvents"], Resource: sub("${WorkerLogGroup.Arn}") },
              { Sid: "RigSecret", Effect: "Allow", Action: "ssm:GetParameter", Resource: sub("arn:${AWS::Partition}:ssm:${AWS::Region}:${AWS::AccountId}:parameter${OpenPlcPasswordParam}") },
              {
                Sid: "RigProbe",
                Effect: "Allow",
                Action: "ssm:SendCommand",
                Resource: [
                  sub("arn:${AWS::Partition}:ssm:${AWS::Region}::document/AWS-RunShellScript"),
                  sub("arn:${AWS::Partition}:ssm:${AWS::Region}::document/AWS-RunPowerShellScript"),
                  sub("arn:${AWS::Partition}:ssm:${AWS::Region}:${AWS::AccountId}:document/${RigHealthProbeDocument}"),
                  ifc("HasRig", instanceArn("RigInstanceId"), NOVALUE),
                  ifc("HasFio", instanceArn("FioInstanceId"), NOVALUE),
                ],
              },
              { Sid: "RigProbeResult", Effect: "Allow", Action: "ssm:GetCommandInvocation", Resource: "*" },
              { Sid: "RigDescribe", Effect: "Allow", Action: "ec2:DescribeInstances", Resource: "*" },
              ifc("HasRig", { Sid: "RigPower", Effect: "Allow", Action: ["ec2:StartInstances", "ec2:StopInstances"], Resource: instanceArn("RigInstanceId") }, NOVALUE),
              ifc("WantSecret", { Sid: "WorkerSecret", Effect: "Allow", Action: "secretsmanager:GetSecretValue", Resource: ref("WorkerSecret") }, NOVALUE),
            ],
          },
        },
      },
    },
    Outputs: {
      ArtifactsBucket: { Value: ref("ArtifactsBucket"), Description: "MM_AWS_ARTIFACTS_BUCKET" },
      WorkerLogGroup: { Value: ref("WorkerLogGroup"), Description: "MM_AWS_LOG_GROUP" },
      WorkerPolicyArn: { Value: ref("WorkerPolicy"), Description: "Attach to the worker's IAM user/role" },
      RigHealthProbeDocument: { Value: ref("RigHealthProbeDocument") },
      WorkerSecretArn: { Condition: "WantSecret", Value: ref("WorkerSecret"), Description: "MM_AWS_SECRETS_ID" },
    },
  };
}

function metricWidget(x: number, title: string, metrics: unknown[], stat: string, y = 0) {
  return { type: "metric", x, y, width: 12, height: 6, properties: { title, metrics, stat, period: 300, region: "${AWS::Region}", view: "timeSeries" } };
}

function powerSchedule(action: "start" | "stop", cronParam: string, description: string) {
  return {
    Type: "AWS::Scheduler::Schedule",
    Condition: "HasRig",
    Properties: {
      Name: `mongomation-rig-${action}`,
      GroupName: ref("SchedulerGroup"),
      Description: description,
      State: ref("RigPowerScheduleState"),
      ScheduleExpression: ref(cronParam),
      ScheduleExpressionTimezone: ref("ScheduleTimezone"),
      FlexibleTimeWindow: { Mode: "OFF" },
      Target: {
        Arn: sub(`arn:\${AWS::Partition}:scheduler:::aws-sdk:ec2:${action}Instances`),
        RoleArn: { "Fn::GetAtt": ["SchedulerRole", "Arn"] },
        Input: sub(JSON.stringify({ InstanceIds: ["${RigInstanceId}"] })),
        RetryPolicy: { MaximumRetryAttempts: 2 },
      },
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) process.stdout.write(JSON.stringify(buildTemplate(), null, 2) + "\n");
