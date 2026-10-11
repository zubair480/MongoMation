// Structured worker events to CloudWatch Logs (JSON lines, one stream per worker process).
// Buffered and flushed in batches; any AWS error is reported once and the sink keeps the worker running.
import { CreateLogStreamCommand, PutLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { awsErr, type Sender } from "./config.ts";

export class CloudWatchLogSink {
  private buf: { timestamp: number; message: string }[] = [];
  private streamReady: Promise<void> | null = null;
  private flushing: Promise<void> = Promise.resolve();
  private warned = false;

  constructor(
    private readonly logs: Sender,
    readonly group: string,
    readonly stream: string,
    private readonly warn: (m: string) => void = () => {},
  ) {}

  /** One structured event. Never throws. */
  emit(event: string, fields: Record<string, unknown> = {}) {
    this.buf.push({ timestamp: Date.now(), message: JSON.stringify({ event, ...fields }, (_k, v) => (typeof v === "bigint" ? String(v) : v)).slice(0, 200_000) });
    if (this.buf.length >= 200) void this.flush();
  }

  private ensureStream() {
    this.streamReady ??= this.logs.send(new CreateLogStreamCommand({ logGroupName: this.group, logStreamName: this.stream })).then(
      () => undefined,
      (e: { name?: string }) => {
        if (e?.name !== "ResourceAlreadyExistsException") {
          this.streamReady = null;
          throw e;
        }
      },
    );
    return this.streamReady;
  }

  flush(): Promise<void> {
    this.flushing = this.flushing.then(async () => {
      if (!this.buf.length) return;
      const batch = this.buf.splice(0, 1000).sort((a, b) => a.timestamp - b.timestamp);
      try {
        await this.ensureStream();
        await this.logs.send(new PutLogEventsCommand({ logGroupName: this.group, logStreamName: this.stream, logEvents: batch }));
      } catch (e) {
        if (!this.warned) this.warn(`aws: CloudWatch Logs write failed (${awsErr(e)}); events are dropped, worker continues`);
        this.warned = true;
      }
    });
    return this.flushing;
  }
}
