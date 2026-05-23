import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { SpoolEventSchema, type SpoolEvent } from "../schemas.ts";
import { startSpyService } from "../service.ts";

const fixturePath = new URL("../fixtures/bedrock-pi-us-sonnet-4-6.ndjson", import.meta.url);

interface Options {
  readonly port: number;
  readonly staticDir: string;
}

const options = parseArgs(Bun.argv.slice(2));
const root = mkdtempSync("/private/tmp/rootcell-spy-ui-");
const spoolDir = resolve(root, "spool");
mkdirSync(spoolDir, { recursive: true });

const events = retimeEvents(readFixtureEvents(), Math.floor(Date.now() / 1000) - 60);
writeSpoolEvents(spoolDir, events.slice(0, 8));

const handle = startSpyService({
  config: {
    bind: "127.0.0.1",
    port: options.port,
    dbPath: resolve(root, "spy.sqlite"),
    spoolDir,
    staticDir: resolve(options.staticDir),
    ingestIntervalMs: 60_000,
    retentionIntervalMs: 60_000,
  },
  startIngestion: false,
});
handle.ingestOnce();

setTimeout(() => {
  writeSpoolEvents(spoolDir, events.slice(8), "late");
  handle.ingestOnce();
}, 5_000);

console.log(`rootcell spy UI test server listening on ${handle.url}`);

const stop = (signal: NodeJS.Signals): void => {
  void handle.stop().finally(() => {
    rmSync(root, { recursive: true, force: true });
    process.exit(signal === "SIGINT" ? 130 : 143);
  });
};

process.once("SIGINT", stop);
process.once("SIGTERM", stop);

await new Promise<void>(() => {
  setInterval(() => undefined, 60_000);
});

function parseArgs(args: readonly string[]): Options {
  let port = 4674;
  let staticDir = "dist/spy-ui";
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = args[index + 1];
    if (arg === "--port" && value !== undefined) {
      port = Number(value);
      index += 1;
    } else if (arg === "--static" && value !== undefined) {
      staticDir = value;
      index += 1;
    }
  }
  return { port, staticDir };
}

function readFixtureEvents(): SpoolEvent[] {
  return readFileSync(fixturePath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => SpoolEventSchema.parse(JSON.parse(line) as unknown));
}

function retimeEvents(events: readonly SpoolEvent[], startTs: number): SpoolEvent[] {
  return events.map((event, index) => ({
    ...event,
    ts: startTs + index,
  }));
}

function writeSpoolEvents(spoolDirPath: string, eventsToWrite: readonly SpoolEvent[], prefix = "seed"): void {
  eventsToWrite.forEach((event, index) => {
    const flowId = "flow_id" in event && event.flow_id !== undefined ? event.flow_id : "no-flow";
    writeFileSync(
      resolve(spoolDirPath, `${prefix}-${String(index).padStart(3, "0")}-${event.direction}-${flowId}.json`),
      `${JSON.stringify(event)}\n`,
    );
  });
}
