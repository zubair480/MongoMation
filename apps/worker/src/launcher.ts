// Tiny supervisor for the "Interrupt Worker" / "Resume from MongoDB" demo.
//   npm run launcher
// Starts the worker; when the dashboard interrupts it (exit 137, a real crash with no cleanup) the launcher does NOT
// restart it, so everyone can see the job stranded in Atlas. The dashboard's "Resume from MongoDB" inserts a
// {type:"worker_command", command:"resume"} job; the launcher starts a fresh worker, which recovers the job from
// its stale heartbeat and continues from the stage checkpoints.
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { col, connect } from "./db/index.ts";

await connect();
let child: ChildProcess | null = null;
const log = (m: string) => console.log(`${new Date().toISOString().slice(11, 19)} [launcher] ${m}`);

function startWorker() {
  child = spawn(process.execPath, ["--import", "tsx", new URL("./main.ts", import.meta.url).pathname], { stdio: "inherit", env: process.env });
  log(`worker started (pid ${child.pid})`);
  child.on("exit", (code, signal) => {
    log(`worker exited (${signal ?? code}) — waiting for "Resume from MongoDB"`);
    child = null;
  });
}

startWorker();
for (;;) {
  const cmd = await col.jobs().findOneAndUpdate(
    { type: "worker_command", status: "queued", command: "resume" },
    { $set: { status: "completed", handledBy: "launcher", finishedAt: new Date() } },
  );
  if (cmd) {
    if (child) log("resume requested but the worker is already running");
    else startWorker();
  }
  await sleep(1000);
}
