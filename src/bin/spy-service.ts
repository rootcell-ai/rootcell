#!/usr/bin/env bun
import { spyServiceConfigFromEnv, startSpyService } from "../spy/service.ts";

const handle = startSpyService({ config: spyServiceConfigFromEnv() });
console.log(`rootcell spy service listening on ${handle.url}`);

const stop = (signal: NodeJS.Signals): void => {
  void handle.stop().finally(() => {
    process.exit(signal === "SIGINT" ? 130 : 143);
  });
};

process.once("SIGINT", stop);
process.once("SIGTERM", stop);
