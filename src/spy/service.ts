import { existsSync, statSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import {
  openSpyStore,
  type IngestSpoolBatchResult,
  type RetentionResult,
  type SpyHealthSnapshot,
  type SpyListCallsOptions,
  type SpySearchCallsOptions,
  type SpyStore,
  type SpyStoreOptions,
  type SpyStreamEventsOptions,
} from "./store.ts";

const DEFAULT_BIND = "127.0.0.1";
const DEFAULT_PORT = 6174;
const DEFAULT_DB_PATH = "/var/lib/rootcell-spy/spy.sqlite";
const DEFAULT_SPOOL_DIR = "/var/spool/rootcell-spy";
const DEFAULT_RETENTION_DAYS = 7;
const DEFAULT_MAX_BYTES = 6 * 1024 * 1024 * 1024;
const DEFAULT_SPOOL_MAX_BYTES = 1024 * 1024 * 1024;
const DEFAULT_INGEST_INTERVAL_MS = 500;
const DEFAULT_RETENTION_INTERVAL_MS = 15 * 60 * 1000;
const DEFAULT_INGEST_BATCH_LIMIT = 100;

const ClearRequestSchema = z.object({
  confirm: z.literal(true),
}).strict();

export interface SpyServiceConfig {
  readonly enabled: boolean;
  readonly bind: string;
  readonly port: number;
  readonly dbPath: string;
  readonly spoolDir: string;
  readonly staticDir?: string | undefined;
  readonly retentionDays: number;
  readonly maxBytes: number;
  readonly spoolMaxBytes: number;
  readonly storeRaw: boolean;
  readonly ingestIntervalMs: number;
  readonly retentionIntervalMs: number;
  readonly ingestBatchLimit: number;
}

export interface SpyServiceHealth {
  readonly ok: true;
  readonly service: {
    readonly enabled: boolean;
    readonly bind: string;
    readonly port: number;
    readonly retentionDays: number;
    readonly maxBytes: number;
    readonly spoolMaxBytes: number;
    readonly storeRaw: boolean;
    readonly staticAssets: boolean;
  };
  readonly store: SpyHealthSnapshot;
}

export interface StartSpyServiceOptions {
  readonly config?: Partial<SpyServiceConfig> | undefined;
  readonly startIngestion?: boolean | undefined;
  readonly now?: (() => number) | undefined;
}

export interface SpyServiceHandle {
  readonly url: string;
  readonly config: SpyServiceConfig;
  readonly store: SpyStore;
  ingestOnce(): IngestSpoolBatchResult;
  runRetentionOnce(): RetentionResult;
  stop(): Promise<void>;
}

interface SseClient {
  readonly id: number;
  readonly controller: ReadableStreamDefaultController<Uint8Array>;
  readonly keepalive: ReturnType<typeof setInterval>;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

class SpyHttpService {
  private readonly encoder = new TextEncoder();
  private readonly clients = new Map<number, SseClient>();
  private ingestTimer: ReturnType<typeof setInterval> | undefined;
  private retentionTimer: ReturnType<typeof setInterval> | undefined;
  private nextClientId = 1;

  constructor(
    private readonly config: SpyServiceConfig,
    private readonly store: SpyStore,
  ) {}

  start(startIngestion: boolean): void {
    this.runRetentionOnce();
    if (!startIngestion) {
      return;
    }
    this.ingestTimer = setInterval(() => {
      this.ingestOnce();
    }, this.config.ingestIntervalMs);
    this.retentionTimer = setInterval(() => {
      this.runRetentionOnce();
    }, this.config.retentionIntervalMs);
  }

  stop(): void {
    if (this.ingestTimer !== undefined) {
      clearInterval(this.ingestTimer);
      this.ingestTimer = undefined;
    }
    if (this.retentionTimer !== undefined) {
      clearInterval(this.retentionTimer);
      this.retentionTimer = undefined;
    }
    for (const client of this.clients.values()) {
      clearInterval(client.keepalive);
      try {
        client.controller.close();
      } catch {
        // The browser may already have disconnected.
      }
    }
    this.clients.clear();
  }

  ingestOnce(): IngestSpoolBatchResult {
    const result = this.store.ingestSpoolBatch({ limit: this.config.ingestBatchLimit });
    if (result.ingested > 0 || result.malformed > 0 || result.errors > 0 || result.deleted > 0) {
      this.broadcast("calls-changed", { result });
      this.broadcastHealth();
    }
    return result;
  }

  runRetentionOnce(): RetentionResult {
    const result = this.store.runRetention();
    if (result.deletedByAge > 0 || result.deletedBySize > 0) {
      this.broadcast("calls-changed", { retention: result });
      this.broadcastHealth();
    }
    return result;
  }

  async handle(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      const path = decodedPathname(url);
      if (path.startsWith("/api/")) {
        return await this.handleApi(request, url, path);
      }
      if (path === "/api") {
        return jsonError(404, "not found");
      }
      return this.serveStatic(path, request.headers);
    } catch (error) {
      return responseForError(error);
    }
  }

  private async handleApi(request: Request, url: URL, path: string): Promise<Response> {
    if (request.method === "GET" && path === "/api/health") {
      return jsonResponse(this.health());
    }
    if (request.method === "GET" && path === "/api/events") {
      return this.sseResponse();
    }
    if (request.method === "GET" && path === "/api/calls") {
      return jsonResponse(this.store.listCallSummaries(listOptions(url)));
    }
    if (request.method === "GET" && path === "/api/search") {
      return jsonResponse(this.store.searchCallSummaries(searchOptions(url)));
    }
    if (request.method === "POST" && path === "/api/clear") {
      const body = await jsonBody(request);
      ClearRequestSchema.parse(body);
      const result = this.store.clearData();
      this.broadcast("cleared", result);
      this.broadcastHealth();
      return jsonResponse(result);
    }

    const streamMatch = /^\/api\/calls\/([^/]+)\/stream-events$/.exec(path);
    if (request.method === "GET" && streamMatch !== null) {
      const callId = decodeURIComponent(streamMatch[1] ?? "");
      return jsonResponse(this.store.getStreamEvents(callId, streamOptions(url)));
    }

    const diffMatch = /^\/api\/calls\/([^/]+)\/diff$/.exec(path);
    if (request.method === "GET" && diffMatch !== null) {
      const callId = decodeURIComponent(diffMatch[1] ?? "");
      const diff = this.store.getCallDiff(callId);
      if (diff === null) {
        throw new HttpError(404, "call not found");
      }
      return jsonResponse(diff);
    }

    const detailMatch = /^\/api\/calls\/([^/]+)$/.exec(path);
    if (request.method === "GET" && detailMatch !== null) {
      const callId = decodeURIComponent(detailMatch[1] ?? "");
      const detail = this.store.getCallDetail(callId);
      if (detail === null) {
        throw new HttpError(404, "call not found");
      }
      return jsonResponse(detail);
    }

    return jsonError(404, "not found");
  }

  private health(): SpyServiceHealth {
    return {
      ok: true,
      service: {
        enabled: this.config.enabled,
        bind: this.config.bind,
        port: this.config.port,
        retentionDays: this.config.retentionDays,
        maxBytes: this.config.maxBytes,
        spoolMaxBytes: this.config.spoolMaxBytes,
        storeRaw: this.config.storeRaw,
        staticAssets: this.config.staticDir !== undefined,
      },
      store: this.store.getHealthSnapshot(),
    };
  }

  private sseResponse(): Response {
    const id = this.nextClientId;
    this.nextClientId += 1;

    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const keepalive = setInterval(() => {
          this.sendComment(controller, "keepalive");
        }, 5_000);
        const client: SseClient = { id, controller, keepalive };
        this.clients.set(id, client);
        this.send(controller, "hello", { id });
        this.send(controller, "health", this.health());
      },
      cancel: () => {
        this.removeClient(id);
      },
    });

    return new Response(stream, {
      headers: {
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Content-Type": "text/event-stream; charset=utf-8",
        "X-Accel-Buffering": "no",
      },
    });
  }

  private serveStatic(path: string, requestHeaders: Headers): Response {
    const staticDir = this.config.staticDir;
    if (staticDir === undefined) {
      return jsonError(404, "not found");
    }

    const root = resolve(staticDir);
    let candidate = path === "/" ? join(root, "index.html") : resolve(root, path.slice(1));
    if (!isPathInside(root, candidate)) {
      throw new HttpError(403, "forbidden");
    }

    const stat = fileStat(candidate);
    if (stat?.isDirectory() === true) {
      candidate = join(candidate, "index.html");
    }

    if (fileStat(candidate)?.isFile() !== true) {
      if (!shouldFallbackToIndex(path, requestHeaders)) {
        return jsonError(404, "not found");
      }
      candidate = join(root, "index.html");
      if (!isPathInside(root, candidate) || fileStat(candidate)?.isFile() !== true) {
        return jsonError(404, "not found");
      }
    }

    return new Response(Bun.file(candidate), {
      headers: {
        "Cache-Control": "no-cache",
        "Content-Type": contentTypeForPath(candidate),
      },
    });
  }

  private broadcastHealth(): void {
    this.broadcast("health", this.health());
  }

  private broadcast(event: string, data: unknown): void {
    for (const client of this.clients.values()) {
      this.send(client.controller, event, data);
    }
  }

  private send(controller: ReadableStreamDefaultController<Uint8Array>, event: string, data: unknown): void {
    try {
      controller.enqueue(this.encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
    } catch {
      // Disconnect cleanup runs through stream cancellation.
    }
  }

  private sendComment(controller: ReadableStreamDefaultController<Uint8Array>, comment: string): void {
    try {
      controller.enqueue(this.encoder.encode(`: ${comment}\n\n`));
    } catch {
      // Disconnect cleanup runs through stream cancellation.
    }
  }

  private removeClient(id: number): void {
    const client = this.clients.get(id);
    if (client === undefined) {
      return;
    }
    clearInterval(client.keepalive);
    this.clients.delete(id);
  }
}

export function spyServiceConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SpyServiceConfig {
  const staticDir = nonEmpty(env.ROOTCELL_SPY_STATIC_DIR);
  return {
    enabled: envBoolean(env.ROOTCELL_SPY_ENABLED, true),
    bind: nonEmpty(env.ROOTCELL_SPY_BIND) ?? DEFAULT_BIND,
    port: envNumber(env.ROOTCELL_SPY_PORT, DEFAULT_PORT),
    dbPath: nonEmpty(env.ROOTCELL_SPY_DB_PATH) ?? DEFAULT_DB_PATH,
    spoolDir: nonEmpty(env.ROOTCELL_SPY_SPOOL_DIR) ?? DEFAULT_SPOOL_DIR,
    ...(staticDir === undefined ? {} : { staticDir }),
    retentionDays: envNumber(env.ROOTCELL_SPY_RETENTION_DAYS, DEFAULT_RETENTION_DAYS),
    maxBytes: envNumber(env.ROOTCELL_SPY_MAX_BYTES, DEFAULT_MAX_BYTES),
    spoolMaxBytes: envNumber(env.ROOTCELL_SPY_SPOOL_MAX_BYTES, DEFAULT_SPOOL_MAX_BYTES),
    storeRaw: envBoolean(env.ROOTCELL_SPY_STORE_RAW, false),
    ingestIntervalMs: envNumber(env.ROOTCELL_SPY_INGEST_INTERVAL_MS, DEFAULT_INGEST_INTERVAL_MS),
    retentionIntervalMs: envNumber(env.ROOTCELL_SPY_RETENTION_INTERVAL_MS, DEFAULT_RETENTION_INTERVAL_MS),
    ingestBatchLimit: envNumber(env.ROOTCELL_SPY_INGEST_BATCH_LIMIT, DEFAULT_INGEST_BATCH_LIMIT),
  };
}

export function startSpyService(options: StartSpyServiceOptions = {}): SpyServiceHandle {
  const config = { ...spyServiceConfigFromEnv({}), ...options.config };
  const storeOptions: SpyStoreOptions = {
    dbPath: config.dbPath,
    spoolDir: config.spoolDir,
    retentionDays: config.retentionDays,
    maxBytes: config.maxBytes,
    storeRaw: config.storeRaw,
    ...(options.now === undefined ? {} : { now: options.now }),
  };
  const store = openSpyStore(storeOptions);
  let service: SpyHttpService | undefined;
  let server: Bun.Server<undefined> | undefined;
  let activeConfig = config;
  let lastListenError: unknown;
  for (const port of candidatePorts(config.port)) {
    activeConfig = { ...config, port };
    service = new SpyHttpService(activeConfig, store);
    try {
      server = Bun.serve({
        hostname: activeConfig.bind,
        port: activeConfig.port,
        fetch: (request) => {
          if (service === undefined) {
            return jsonError(503, "service unavailable");
          }
          return service.handle(request);
        },
      });
      break;
    } catch (error) {
      lastListenError = error;
      if (config.port !== 0 || !isAddrInUse(error)) {
        store.close();
        throw error;
      }
    }
  }
  if (server === undefined || service === undefined) {
    store.close();
    throw lastListenError instanceof Error ? lastListenError : new Error("failed to start spy service");
  }
  try {
    service.start(options.startIngestion ?? true);
  } catch (error) {
    void server.stop(true);
    store.close();
    throw error;
  }
  const actualPort = server.port ?? activeConfig.port;

  return {
    url: `http://${activeConfig.bind}:${String(actualPort)}`,
    config: { ...activeConfig, port: actualPort },
    store,
    ingestOnce: () => service.ingestOnce(),
    runRetentionOnce: () => service.runRetentionOnce(),
    stop: async () => {
      service.stop();
      await server.stop(true);
      store.close();
    },
  };
}

function listOptions(url: URL): SpyListCallsOptions {
  return {
    ...(numberParam(url, "since") === undefined ? {} : { since: numberParam(url, "since") }),
    ...(stringParam(url, "cursor") === undefined ? {} : { cursor: stringParam(url, "cursor") }),
    ...(numberParam(url, "limit") === undefined ? {} : { limit: numberParam(url, "limit") }),
  };
}

function searchOptions(url: URL): SpySearchCallsOptions {
  return {
    query: stringParam(url, "q") ?? "",
    ...(stringParam(url, "cursor") === undefined ? {} : { cursor: stringParam(url, "cursor") }),
    ...(numberParam(url, "limit") === undefined ? {} : { limit: numberParam(url, "limit") }),
  };
}

function streamOptions(url: URL): SpyStreamEventsOptions {
  return {
    ...(stringParam(url, "cursor") === undefined ? {} : { cursor: stringParam(url, "cursor") }),
    ...(numberParam(url, "limit") === undefined ? {} : { limit: numberParam(url, "limit") }),
  };
}

async function jsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
}

function stringParam(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name);
  return value === null || value.length === 0 ? undefined : value;
}

function numberParam(url: URL, name: string): number | undefined {
  const value = stringParam(url, name);
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new HttpError(400, `invalid ${name}`);
  }
  return parsed;
}

function decodedPathname(url: URL): string {
  try {
    const decoded = decodeURIComponent(url.pathname);
    if (decoded.includes("\0")) {
      throw new HttpError(400, "invalid path");
    }
    return decoded;
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }
    throw new HttpError(400, "invalid path");
  }
}

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    ...(init.status === undefined ? {} : { status: init.status }),
    ...(init.statusText === undefined ? {} : { statusText: init.statusText }),
    headers: {
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function jsonError(status: number, message: string): Response {
  return jsonResponse({ error: message }, { status });
}

function responseForError(error: unknown): Response {
  if (error instanceof HttpError) {
    return jsonError(error.status, error.message);
  }
  if (error instanceof z.ZodError) {
    return jsonError(400, error.issues[0]?.message ?? "invalid request");
  }
  if (error instanceof Error && error.message.includes("cursor")) {
    return jsonError(400, error.message);
  }
  return jsonError(500, error instanceof Error ? error.message : "internal error");
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function envNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim().length === 0) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function envBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim().length === 0) {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function candidatePorts(port: number): number[] {
  if (port !== 0) {
    return [port];
  }
  const ports: number[] = [];
  const base = 20_000 + Math.floor(Math.random() * 20_000);
  for (let offset = 0; offset < 40; offset += 1) {
    ports.push(base + offset);
  }
  return ports;
}

function isAddrInUse(error: unknown): boolean {
  if (error instanceof Error && error.message.includes("EADDRINUSE")) {
    return true;
  }
  if (error instanceof Error && error.message.includes("in use")) {
    return true;
  }
  if (typeof error !== "object" || error === null) {
    return false;
  }
  if ("code" in error && error.code === "EADDRINUSE") {
    return true;
  }
  return "message" in error
    && typeof error.message === "string"
    && (error.message.includes("EADDRINUSE") || error.message.includes("in use"));
}

function isPathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel.length === 0 || (!rel.startsWith("..") && !isAbsolute(rel));
}

function fileStat(path: string): ReturnType<typeof statSync> | null {
  if (!existsSync(path)) {
    return null;
  }
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function shouldFallbackToIndex(path: string, requestHeaders: Headers): boolean {
  if (path === "/") {
    return true;
  }
  const accept = requestHeaders.get("accept") ?? "";
  return extname(path).length === 0 || accept.includes("text/html");
}

function contentTypeForPath(path: string): string {
  const extension = extname(path).toLowerCase();
  if (extension === ".html") {
    return "text/html; charset=utf-8";
  }
  if (extension === ".js" || extension === ".mjs") {
    return "text/javascript; charset=utf-8";
  }
  if (extension === ".css") {
    return "text/css; charset=utf-8";
  }
  if (extension === ".json") {
    return "application/json; charset=utf-8";
  }
  if (extension === ".svg") {
    return "image/svg+xml";
  }
  if (extension === ".png") {
    return "image/png";
  }
  if (extension === ".ico") {
    return "image/x-icon";
  }
  return "application/octet-stream";
}
