import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Activity,
  AlertTriangle,
  ArrowUp,
  BadgeInfo,
  Clock,
  Database,
  Filter,
  Loader2,
  RefreshCcw,
  Search,
  Server,
  Trash2,
  Wifi,
  WifiOff,
} from "lucide-react";
import * as React from "react";
import { SpyApiClient, initialTimelineRangeFromLocation, parseSseEventData, replaceTimelineRangeUrl, resolveTimelineSince } from "./api.ts";
import { Badge } from "./components/ui/badge.tsx";
import { Button } from "./components/ui/button.tsx";
import { Input } from "./components/ui/input.tsx";
import { Select } from "./components/ui/select.tsx";
import {
  blockKindLabel,
  blockText,
  clipped,
  formatBytes,
  formatDateTime,
  formatDuration,
  formatNumber,
  formatTime,
  formatUsageTotal,
  shortModelId,
  statusTone,
} from "./format.ts";
import { cn } from "./lib/utils.ts";
import type {
  DiffClassification,
  HttpEventRecord,
  NormalizedBlock,
  RawPayloadRecord,
  SpyCallDetail,
  SpyCallDiff,
  SpyRequestComposition,
  SpyCallSummary,
  SpyServiceHealth,
  StreamEvent,
  TimePreset,
  UiFilters,
  UsageRecord,
} from "./types.ts";

const api = new SpyApiClient();
const CALL_LIMIT = 100;
const ALL_FILTER = "all";
const TIMELINE_ROW_ESTIMATE = 138;
const BLOCK_SECTION_AUTO_OPEN_MAX_BLOCKS = 6;
const BLOCK_SECTION_AUTO_OPEN_MAX_BYTES = 24 * 1024;
const STREAM_EVENT_WINDOW_SIZE = 25;
const STREAM_EVENT_PAYLOAD_PREVIEW_CHARS = 4_000;
const PROVIDER_OPTIONS = [
  { value: "bedrock", label: "Bedrock" },
] as const;
const OPERATION_OPTIONS = [
  { value: "invoke", label: "Invoke" },
  { value: "invoke-with-response-stream", label: "Invoke Stream" },
  { value: "converse", label: "Converse" },
  { value: "converse-stream", label: "Converse Stream" },
] as const;

type LoadState = "idle" | "loading" | "error";
type TimelineEmptyState = "range" | "query";
type InspectorSectionId =
  | "summary"
  | "composition"
  | "request-blocks"
  | "response-blocks"
  | "diff"
  | "usage"
  | "network"
  | "stream"
  | "raw"
  | "health";

const INSPECTOR_SECTIONS: readonly { readonly id: InspectorSectionId; readonly label: string }[] = [
  { id: "summary", label: "Summary" },
  { id: "composition", label: "Composition" },
  { id: "request-blocks", label: "Request" },
  { id: "response-blocks", label: "Response" },
  { id: "diff", label: "Diff" },
  { id: "usage", label: "Usage" },
  { id: "network", label: "Network" },
  { id: "stream", label: "Stream" },
  { id: "raw", label: "Raw" },
  { id: "health", label: "Health" },
] as const;

interface DetailState {
  readonly callId: string;
  readonly detail: SpyCallDetail | null;
  readonly diff: SpyCallDiff | null;
  readonly state: LoadState;
  readonly error?: string | undefined;
}

type LoadedDetailState = DetailState & {
  readonly detail: SpyCallDetail;
  readonly diff: SpyCallDiff;
};

interface StreamState {
  readonly callId: string;
  readonly items: readonly StreamEvent[];
  readonly windowStart: number;
  readonly nextCursor?: string | undefined;
  readonly state: LoadState;
  readonly expandedEventId?: string | undefined;
  readonly error?: string | undefined;
}

export function App(): React.ReactElement {
  const initialRange = React.useMemo(() => initialTimelineRangeFromLocation(window.location), []);
  const [preset, setPreset] = React.useState<TimePreset>(initialRange.preset);
  const [since, setSince] = React.useState(initialRange.since);
  const [customStart, setCustomStart] = React.useState(() => datetimeLocalValue(initialRange.since));
  const [searchDraft, setSearchDraft] = React.useState("");
  const [search, setSearch] = React.useState("");
  const [filters, setFilters] = React.useState<UiFilters>({
    provider: ALL_FILTER,
    model: ALL_FILTER,
    operation: ALL_FILTER,
    status: ALL_FILTER,
    blockKind: ALL_FILTER,
  });
  const [calls, setCalls] = React.useState<readonly SpyCallSummary[]>([]);
  const [nextCursor, setNextCursor] = React.useState<string | undefined>();
  const [callState, setCallState] = React.useState<LoadState>("idle");
  const [callError, setCallError] = React.useState<string | undefined>();
  const [selectedCallId, setSelectedCallId] = React.useState<string | undefined>();
  const [detailState, setDetailState] = React.useState<DetailState | null>(null);
  const [streamState, setStreamState] = React.useState<StreamState | null>(null);
  const [inspectorResetKey, setInspectorResetKey] = React.useState(0);
  const [health, setHealth] = React.useState<SpyServiceHealth | null>(null);
  const [sseConnected, setSseConnected] = React.useState(false);
  const [sseError, setSseError] = React.useState<string | undefined>();
  const [clearOpen, setClearOpen] = React.useState(false);
  const [clearing, setClearing] = React.useState(false);
  const timelineEmptyState = timelineEmptyStateFor(search, filters);
  const timelineContextKey = React.useMemo(() => [
    since,
    search,
    filters.provider,
    filters.model,
    filters.operation,
    filters.status,
  ].join("|"), [filters.model, filters.operation, filters.provider, filters.status, search, since]);
  const previousTimelineContextKey = React.useRef<string | null>(null);
  const previousSelectedCallId = React.useRef<string | undefined>(undefined);

  const loadCalls = React.useCallback(async (options: { readonly cursor?: string | undefined; readonly append?: boolean | undefined } = {}) => {
    setCallState("loading");
    setCallError(undefined);
    try {
      const page = await api.calls({
        since: sinceForCallLoad(options.append === true),
        search,
        limit: CALL_LIMIT,
        provider: filterQueryValue(filters.provider),
        modelId: filterQueryValue(filters.model),
        operation: filterQueryValue(filters.operation),
        status: filterQueryValue(filters.status),
        ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
      });
      setCalls((current) => options.append === true ? [...current, ...page.items] : page.items);
      setNextCursor(page.nextCursor);
      setCallState("idle");
      setSelectedCallId((current) => {
        if (options.append === true) {
          return current ?? page.items[0]?.call.id;
        }
        if (current !== undefined && page.items.some((item) => item.call.id === current)) {
          return current;
        }
        return page.items[0]?.call.id;
      });
    } catch (error) {
      setCallState("error");
      setCallError(error instanceof Error ? error.message : "failed to load calls");
    }
  }, [filters.model, filters.operation, filters.provider, filters.status, preset, search, since]);

  React.useEffect(() => {
    void loadCalls();
  }, [loadCalls]);

  React.useEffect(() => {
    if (previousTimelineContextKey.current !== null && previousTimelineContextKey.current !== timelineContextKey) {
      setStreamState(null);
      resetInspectorScroll();
    }
    previousTimelineContextKey.current = timelineContextKey;
  }, [timelineContextKey]);

  React.useEffect(() => {
    if (previousSelectedCallId.current !== selectedCallId) {
      setStreamState(null);
      resetInspectorScroll();
      previousSelectedCallId.current = selectedCallId;
    }
  }, [selectedCallId]);

  React.useEffect(() => {
    let cancelled = false;
    void api.health().then((snapshot) => {
      if (!cancelled) {
        setHealth(snapshot);
      }
    }).catch(() => {
      if (!cancelled) {
        setHealth(null);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  React.useEffect(() => {
    const source = new EventSource("/api/events");
    const onOpen = (): void => {
      setSseConnected(true);
    };
    const onError = (): void => {
      setSseConnected(false);
    };
    const onHello = (event: MessageEvent<string>): void => {
      try {
        parseSseEventData("hello", event.data);
        setSseConnected(true);
        setSseError(undefined);
      } catch (error) {
        setSseConnected(false);
        setSseError(sseErrorMessage(error));
      }
    };
    const onHealth = (event: MessageEvent<string>): void => {
      try {
        setHealth(parseSseEventData("health", event.data));
        setSseConnected(true);
        setSseError(undefined);
      } catch (error) {
        setSseConnected(false);
        setSseError(sseErrorMessage(error));
      }
    };
    const onCallsChanged = (event: MessageEvent<string>): void => {
      try {
        parseSseEventData("calls-changed", event.data);
        setSseError(undefined);
        void loadCalls();
      } catch (error) {
        setSseConnected(false);
        setSseError(sseErrorMessage(error));
      }
    };
    const onCleared = (event: MessageEvent<string>): void => {
      try {
        parseSseEventData("cleared", event.data);
        setSseError(undefined);
      } catch (error) {
        setSseConnected(false);
        setSseError(sseErrorMessage(error));
        return;
      }
      setCalls([]);
      setNextCursor(undefined);
      setSelectedCallId(undefined);
      setDetailState(null);
      setStreamState(null);
      void api.health().then(setHealth);
    };

    source.addEventListener("open", onOpen);
    source.addEventListener("error", onError);
    source.addEventListener("hello", onHello as EventListener);
    source.addEventListener("health", onHealth as EventListener);
    source.addEventListener("calls-changed", onCallsChanged as EventListener);
    source.addEventListener("cleared", onCleared as EventListener);

    return () => {
      source.removeEventListener("open", onOpen);
      source.removeEventListener("error", onError);
      source.removeEventListener("hello", onHello as EventListener);
      source.removeEventListener("health", onHealth as EventListener);
      source.removeEventListener("calls-changed", onCallsChanged as EventListener);
      source.removeEventListener("cleared", onCleared as EventListener);
      source.close();
    };
  }, [loadCalls]);

  const selectedSummary = React.useMemo(() => {
    return calls.find((summary) => summary.call.id === selectedCallId) ?? null;
  }, [calls, selectedCallId]);
  const latestVisibleSummary = calls[0] ?? null;
  const selectedCallIsPinned = selectedSummary !== null
    && latestVisibleSummary !== null
    && selectedSummary.call.id !== latestVisibleSummary.call.id;

  const selectedDetailVersion = React.useMemo(() => {
    if (selectedSummary === null) {
      return selectedCallId;
    }
    return [
      selectedSummary.call.id,
      selectedSummary.call.status,
      selectedSummary.call.completed_at ?? "pending",
      selectedSummary.call.request_content_hash ?? "",
      selectedSummary.call.response_content_hash ?? "",
      selectedSummary.durationMs ?? "pending",
      selectedSummary.usage.totalTokens ?? "usage-pending",
      selectedSummary.responseBlockCount,
      selectedSummary.responseByteSize,
      selectedSummary.streamEventCount,
    ].join("|");
  }, [selectedCallId, selectedSummary]);

  React.useEffect(() => {
    if (selectedCallId === undefined) {
      return;
    }
    let cancelled = false;
    setDetailState({ callId: selectedCallId, detail: null, diff: null, state: "loading" });
    setStreamState(null);
    void Promise.all([
      api.callDetail(selectedCallId),
      api.callDiff(selectedCallId),
    ]).then(([detail, diff]) => {
      if (!cancelled) {
        setDetailState({ callId: selectedCallId, detail, diff, state: "idle" });
      }
    }).catch((error: unknown) => {
      if (!cancelled) {
        setDetailState({
          callId: selectedCallId,
          detail: null,
          diff: null,
          state: "error",
          error: error instanceof Error ? error.message : "failed to load call detail",
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [selectedCallId, selectedDetailVersion]);

  const modelOptions = React.useMemo(() => {
    return [
      ...new Set([
        ...calls.map((summary) => summary.call.model_id),
        ...(filters.model === ALL_FILTER ? [] : [filters.model]),
      ]),
    ].sort();
  }, [calls, filters.model]);

  function setPresetSince(nextPreset: TimePreset): void {
    setTimelineRange(nextPreset, resolveTimelineSince(nextPreset, since));
  }

  function applyCustomStart(): void {
    const next = secondsFromDatetimeLocal(customStart);
    if (next !== null) {
      setTimelineRange("custom", next);
    }
  }

  function setTimelineRange(nextPreset: TimePreset, nextSince: number): void {
    setPreset(nextPreset);
    setSince(nextSince);
    setCustomStart(datetimeLocalValue(nextSince));
    replaceTimelineRangeUrl(nextPreset, nextSince);
  }

  function sinceForCallLoad(append: boolean): number {
    if (append || !isRollingPreset(preset)) {
      return since;
    }
    const nextSince = resolveTimelineSince(preset, since);
    if (nextSince !== since) {
      setSince(nextSince);
      setCustomStart(datetimeLocalValue(nextSince));
      replaceTimelineRangeUrl(preset, nextSince);
    }
    return nextSince;
  }

  function submitSearch(event: React.SyntheticEvent<HTMLFormElement>): void {
    event.preventDefault();
    setSearch(searchDraft);
  }

  async function loadMore(): Promise<void> {
    if (nextCursor !== undefined) {
      await loadCalls({ cursor: nextCursor, append: true });
    }
  }

  async function loadStreamEvents(more = false): Promise<void> {
    if (selectedCallId === undefined) {
      return;
    }
    const cursor = more ? streamState?.nextCursor : undefined;
    setStreamState((current) => ({
      callId: selectedCallId,
      items: more ? current?.items ?? [] : [],
      windowStart: more ? current?.windowStart ?? 0 : 0,
      state: "loading",
      ...(cursor === undefined ? {} : { nextCursor: cursor }),
    }));
    try {
      const page = await api.streamEvents(selectedCallId, cursor);
      setStreamState((current) => {
        const currentItems = more ? current?.items ?? [] : [];
        const items = more ? [...currentItems, ...page.items] : page.items;
        return {
          callId: selectedCallId,
          items,
          windowStart: more ? streamWindowStartForIndex(currentItems.length, items.length) : 0,
          nextCursor: page.nextCursor,
          state: "idle",
        };
      });
    } catch (error) {
      setStreamState({
        callId: selectedCallId,
        items: more ? streamState?.items ?? [] : [],
        windowStart: more ? streamState?.windowStart ?? 0 : 0,
        state: "error",
        error: error instanceof Error ? error.message : "failed to load stream events",
      });
    }
  }

  function setStreamWindowStart(windowStart: number): void {
    setStreamState((current) => {
      if (current === null) {
        return current;
      }
      return {
        ...current,
        expandedEventId: undefined,
        windowStart: streamWindowStartForIndex(windowStart, current.items.length),
      };
    });
  }

  function toggleStreamPayload(eventId: string): void {
    setStreamState((current) => {
      if (current === null) {
        return current;
      }
      return {
        ...current,
        expandedEventId: current.expandedEventId === eventId ? undefined : eventId,
      };
    });
  }

  function selectTimelineCall(callId: string): void {
    if (callId === selectedCallId) {
      resetSelectedCallInspection();
      return;
    }
    setSelectedCallId(callId);
  }

  function resetSelectedCallInspection(): void {
    setStreamState(null);
    setInspectorResetKey((key) => key + 1);
    resetInspectorScroll();
  }

  async function clearData(): Promise<void> {
    setClearing(true);
    try {
      await api.clearData();
      setClearOpen(false);
    } finally {
      setClearing(false);
    }
  }

  return (
    <main className="grid h-screen min-h-0 grid-rows-[4rem_minmax(0,1fr)] overflow-hidden bg-[#f7f5f2] text-stone-950">
      <header className="flex h-16 items-center justify-between border-b border-stone-300 bg-white px-5">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-md bg-emerald-700 text-white">
            <Activity aria-hidden="true" size={19} />
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold">Rootcell Spy</h1>
            <p className="truncate text-xs text-stone-500">
              {preset === "live" ? "Live from now" : `Since ${formatDateTime(since)}`}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Badge tone={sseConnected ? "teal" : "amber"} className="gap-1">
            {sseConnected ? <Wifi aria-hidden="true" size={13} /> : <WifiOff aria-hidden="true" size={13} />}
            {sseConnected ? "SSE" : "Reconnect"}
          </Badge>
          <Badge tone={health?.service.storeRaw === true ? "amber" : "neutral"}>raw {health?.service.storeRaw === true ? "on" : "off"}</Badge>
          <Button aria-label="Refresh calls" size="icon" onClick={() => {
            void loadCalls();
          }}>
            <RefreshCcw aria-hidden="true" size={16} />
          </Button>
          <Button aria-label="Clear spy data" size="icon" variant="danger" onClick={() => {
            setClearOpen(true);
          }}>
            <Trash2 aria-hidden="true" size={16} />
          </Button>
        </div>
      </header>

      <section className="grid min-h-0 overflow-hidden grid-cols-[minmax(520px,44vw)_minmax(0,1fr)]">
        <div className="flex min-h-0 min-w-0 flex-col border-r border-stone-300 bg-[#fbfaf8]">
          <TimelineControls
            preset={preset}
            customStart={customStart}
            searchDraft={searchDraft}
            filters={filters}
            modelOptions={modelOptions}
            callState={callState}
            onPreset={setPresetSince}
            onCustomStart={setCustomStart}
            onApplyCustomStart={applyCustomStart}
            onSearchDraft={setSearchDraft}
            onSubmitSearch={submitSearch}
            onFilters={setFilters}
          />
          {callError === undefined ? null : (
            <div className="mx-4 mt-3 flex items-center gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
              <AlertTriangle aria-hidden="true" size={16} />
              {callError}
            </div>
          )}
          {sseError === undefined ? null : (
            <div className="mx-4 mt-3 flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              <AlertTriangle aria-hidden="true" size={16} />
              {sseError}
            </div>
          )}
          <Timeline
            calls={calls}
            selectedCallId={selectedCallId}
            loading={callState === "loading"}
            hasMore={nextCursor !== undefined}
            emptyState={timelineEmptyState}
            onSelect={selectTimelineCall}
            onLoadMore={() => {
              void loadMore();
            }}
          />
        </div>

        <CallInspector
          summary={selectedSummary}
          detailState={detailState}
          streamState={streamState}
          resetKey={inspectorResetKey}
          pinned={selectedCallIsPinned}
          filters={filters}
          health={health}
          onFilters={setFilters}
          onFollowLatest={() => {
            if (latestVisibleSummary !== null) {
              setSelectedCallId(latestVisibleSummary.call.id);
            }
          }}
          onLoadStream={() => {
            void loadStreamEvents(false);
          }}
          onLoadMoreStream={() => {
            void loadStreamEvents(true);
          }}
          onStreamWindowStart={setStreamWindowStart}
          onToggleStreamPayload={toggleStreamPayload}
        />
      </section>

      {clearOpen ? (
        <ClearDialog
          clearing={clearing}
          onCancel={() => {
            setClearOpen(false);
          }}
          onConfirm={() => {
            void clearData();
          }}
        />
      ) : null}
    </main>
  );
}

function TimelineControls(props: {
  readonly preset: TimePreset;
  readonly customStart: string;
  readonly searchDraft: string;
  readonly filters: UiFilters;
  readonly modelOptions: readonly string[];
  readonly callState: LoadState;
  readonly onPreset: (preset: TimePreset) => void;
  readonly onCustomStart: (value: string) => void;
  readonly onApplyCustomStart: () => void;
  readonly onSearchDraft: (value: string) => void;
  readonly onSubmitSearch: (event: React.SyntheticEvent<HTMLFormElement>) => void;
  readonly onFilters: (filters: UiFilters) => void;
}): React.ReactElement {
  const { filters } = props;
  return (
    <div className="border-b border-stone-300 bg-white p-4">
      <div className="flex flex-wrap items-center gap-2">
        <SegmentButton active={props.preset === "live"} onClick={() => {
          props.onPreset("live");
        }}>Live</SegmentButton>
        <SegmentButton active={props.preset === "10m"} onClick={() => {
          props.onPreset("10m");
        }}>10 min</SegmentButton>
        <SegmentButton active={props.preset === "1h"} onClick={() => {
          props.onPreset("1h");
        }}>1 hour</SegmentButton>
        <SegmentButton active={props.preset === "today"} onClick={() => {
          props.onPreset("today");
        }}>Today</SegmentButton>
        <div className="ml-auto flex items-center gap-2">
          <Clock aria-hidden="true" className="text-stone-500" size={16} />
          <Input
            aria-label="Custom start time"
            className="w-[190px]"
            type="datetime-local"
            value={props.customStart}
            onChange={(event) => {
              props.onCustomStart(event.target.value);
            }}
          />
          <Button size="sm" variant={props.preset === "custom" ? "primary" : "secondary"} onClick={props.onApplyCustomStart}>
            Apply
          </Button>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <form className="relative min-w-[245px] flex-1" onSubmit={props.onSubmitSearch}>
          <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-stone-500" size={15} />
          <Input
            aria-label="Search normalized text"
            className="pl-9 pr-24"
            placeholder="Search text"
            value={props.searchDraft}
            onChange={(event) => {
              props.onSearchDraft(event.target.value);
            }}
          />
          <Button className="absolute right-1 top-1/2 -translate-y-1/2" size="sm" type="submit">
            Search
          </Button>
        </form>
        <Filter aria-hidden="true" className="text-stone-500" size={16} />
        <Select
          aria-label="Filter by provider"
          value={filters.provider}
          onChange={(event) => {
            props.onFilters({ ...filters, provider: event.target.value });
          }}
        >
          <option value={ALL_FILTER}>All providers</option>
          {PROVIDER_OPTIONS.map((provider) => (
            <option key={provider.value} value={provider.value}>{provider.label}</option>
          ))}
        </Select>
        <Select
          aria-label="Filter by operation"
          value={filters.operation}
          onChange={(event) => {
            props.onFilters({ ...filters, operation: event.target.value });
          }}
        >
          <option value={ALL_FILTER}>All operations</option>
          {OPERATION_OPTIONS.map((operation) => (
            <option key={operation.value} value={operation.value}>{operation.label}</option>
          ))}
        </Select>
        <Select
          aria-label="Filter by status"
          value={filters.status}
          onChange={(event) => {
            props.onFilters({ ...filters, status: event.target.value });
          }}
        >
          <option value={ALL_FILTER}>All status</option>
          <option value="complete">Complete</option>
          <option value="pending">Pending</option>
          <option value="error">Error</option>
          <option value="dropped">Dropped</option>
        </Select>
        <Select
          aria-label="Filter by model"
          className="max-w-[210px] flex-1"
          value={filters.model}
          onChange={(event) => {
            props.onFilters({ ...filters, model: event.target.value });
          }}
        >
          <option value={ALL_FILTER}>All models</option>
          {props.modelOptions.map((model) => (
            <option key={model} value={model}>{shortModelId(model)}</option>
          ))}
        </Select>
        {props.callState === "loading" ? <Loader2 aria-label="Loading calls" className="animate-spin text-stone-500" size={18} /> : null}
      </div>
    </div>
  );
}

function SegmentButton(props: {
  readonly active: boolean;
  readonly children: React.ReactNode;
  readonly onClick: () => void;
}): React.ReactElement {
  return (
    <Button
      size="sm"
      variant={props.active ? "primary" : "secondary"}
      onClick={props.onClick}
    >
      {props.children}
    </Button>
  );
}

function Timeline(props: {
  readonly calls: readonly SpyCallSummary[];
  readonly selectedCallId: string | undefined;
  readonly loading: boolean;
  readonly hasMore: boolean;
  readonly emptyState: TimelineEmptyState;
  readonly onSelect: (callId: string) => void;
  readonly onLoadMore: () => void;
}): React.ReactElement {
  const parentRef = React.useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: props.calls.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => TIMELINE_ROW_ESTIMATE,
    overscan: 8,
  });
  const virtualItems = virtualizer.getVirtualItems();

  if (props.calls.length === 0 && !props.loading) {
    const message = props.emptyState === "query"
      ? "No provider calls match the current search or filters."
      : "No provider calls in this range.";
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-center text-sm text-stone-500" data-testid="timeline-empty">
        {message}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={parentRef} className="spy-scrollbar relative min-h-0 flex-1 overflow-auto" data-testid="timeline">
        <div className="relative w-full" style={{ height: `${String(virtualizer.getTotalSize())}px` }}>
          {virtualItems.map((virtualRow) => {
            const summary = props.calls[virtualRow.index];
            if (summary === undefined) {
              return null;
            }
            return (
              <div
                key={summary.call.id}
                ref={virtualizer.measureElement}
                data-index={virtualRow.index}
                className="absolute left-0 top-0 w-full px-4 py-2"
                style={{ transform: `translateY(${String(virtualRow.start)}px)` }}
              >
                <TimelineRow
                  summary={summary}
                  selected={summary.call.id === props.selectedCallId}
                  onSelect={() => {
                    props.onSelect(summary.call.id);
                  }}
                />
              </div>
            );
          })}
        </div>
      </div>
      <div className="border-t border-stone-300 bg-white/95 p-3 backdrop-blur" data-testid="timeline-footer">
        <div className="flex items-center justify-between text-xs text-stone-500">
          <span>{formatNumber(props.calls.length)} calls</span>
          <Button size="sm" disabled={!props.hasMore || props.loading} onClick={props.onLoadMore}>
            Load More
          </Button>
        </div>
      </div>
    </div>
  );
}

function TimelineRow(props: {
  readonly summary: SpyCallSummary;
  readonly selected: boolean;
  readonly onSelect: () => void;
}): React.ReactElement {
  const { summary } = props;
  return (
    <button
      type="button"
      className={cn(
        "grid w-full grid-cols-[auto_minmax(0,1fr)] gap-3 rounded-md border bg-white p-3 text-left shadow-sm transition-colors",
        props.selected ? "border-emerald-600 ring-2 ring-emerald-600/20" : "border-stone-250 hover:border-stone-400 hover:bg-stone-50",
      )}
      onClick={props.onSelect}
      aria-label={`Open call ${summary.call.id}`}
      data-testid="timeline-row"
    >
      <div className="mt-1 flex h-9 w-9 items-center justify-center rounded-md border border-stone-300 bg-stone-50 text-stone-700">
        <Server aria-hidden="true" size={17} />
      </div>
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-semibold">{shortModelId(summary.call.model_id)}</span>
          <Badge tone={statusTone(summary.call.status)}>{summary.call.status}</Badge>
          {summary.cacheMarkerCount > 0 ? <Badge tone="blue">cache {formatNumber(summary.cacheMarkerCount)}</Badge> : null}
          <span className="ml-auto text-xs text-stone-500">{formatTime(summary.call.started_at)}</span>
        </div>
        <div className="mt-2 grid grid-cols-4 gap-2 text-xs text-stone-600">
          <Metric label="input" value={formatBytes(summary.requestByteSize)} />
          <Metric label="output" value={formatBytes(summary.responseByteSize)} />
          <Metric label="usage" value={formatUsageTotal(summary.usage)} />
          <Metric label="duration" value={formatDuration(summary.durationMs)} />
        </div>
        <div className="mt-2 truncate text-xs text-stone-500">
          {summary.call.operation} · {summary.requestBlockCount} request blocks · {summary.responseBlockCount} response blocks
        </div>
      </div>
    </button>
  );
}

function Metric(props: { readonly label: string; readonly value: string }): React.ReactElement {
  return (
    <span className="min-w-0 rounded-md bg-stone-100 px-2 py-1">
      <span className="text-stone-500">{props.label}</span>{" "}
      <span className="font-medium text-stone-900">{props.value}</span>
    </span>
  );
}

function CallInspector(props: {
  readonly summary: SpyCallSummary | null;
  readonly detailState: DetailState | null;
  readonly streamState: StreamState | null;
  readonly resetKey: number;
  readonly pinned: boolean;
  readonly filters: UiFilters;
  readonly health: SpyServiceHealth | null;
  readonly onFilters: (filters: UiFilters) => void;
  readonly onFollowLatest: () => void;
  readonly onLoadStream: () => void;
  readonly onLoadMoreStream: () => void;
  readonly onStreamWindowStart: (windowStart: number) => void;
  readonly onToggleStreamPayload: (eventId: string) => void;
}): React.ReactElement {
  const detailState = props.detailState;
  const showSectionNav = props.summary !== null && isLoadedDetailState(detailState);
  let content: React.ReactNode;
  if (props.summary === null) {
    content = <EmptyInspector health={props.health} />;
  } else if (detailState?.state === "loading") {
    content = <LoadingPanel label="Loading call detail" />;
  } else if (detailState?.state === "error") {
    content = <ErrorPanel message={detailState.error ?? "failed to load call detail"} />;
  } else if (!isLoadedDetailState(detailState)) {
    content = <EmptyInspector health={props.health} />;
  } else {
    content = (
      <InspectorContent
        key={props.resetKey}
        detail={detailState.detail}
        diff={detailState.diff}
        streamState={props.streamState}
        filters={props.filters}
        health={props.health}
        onFilters={props.onFilters}
        onLoadStream={props.onLoadStream}
        onLoadMoreStream={props.onLoadMoreStream}
        onStreamWindowStart={props.onStreamWindowStart}
        onToggleStreamPayload={props.onToggleStreamPayload}
      />
    );
  }

  return (
    <aside className="spy-scrollbar min-h-0 min-w-0 overflow-auto bg-[#f3f0eb]">
      <div className="sticky top-0 z-10 border-b border-stone-300 bg-white px-5 py-3">
        <div className="flex min-w-0 items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold">
              {props.summary === null ? "Call Inspector" : shortModelId(props.summary.call.model_id)}
            </h2>
            <p className="truncate text-xs text-stone-500">
              {props.summary === null ? "Select a provider call." : props.summary.call.id}
            </p>
          </div>
          {props.summary === null ? null : (
            <div className="flex shrink-0 items-center gap-2">
              {props.pinned ? (
                <>
                  <span data-testid="inspector-pinned-state">
                    <Badge tone="amber">Pinned</Badge>
                  </span>
                  <Button size="sm" onClick={props.onFollowLatest}>
                    <ArrowUp aria-hidden="true" size={14} />
                    Follow Latest
                  </Button>
                </>
              ) : null}
              <Badge tone={statusTone(props.summary.call.status)}>{props.summary.call.status}</Badge>
            </div>
          )}
        </div>
        {showSectionNav ? <InspectorSectionNav /> : null}
      </div>

      <div className="space-y-4 p-5">
        {content}
      </div>
    </aside>
  );
}

function isLoadedDetailState(state: DetailState | null): state is LoadedDetailState {
  return state?.detail !== undefined && state.detail !== null && state.diff !== null;
}

function InspectorContent(props: {
  readonly detail: SpyCallDetail;
  readonly diff: SpyCallDiff;
  readonly streamState: StreamState | null;
  readonly filters: UiFilters;
  readonly health: SpyServiceHealth | null;
  readonly onFilters: (filters: UiFilters) => void;
  readonly onLoadStream: () => void;
  readonly onLoadMoreStream: () => void;
  readonly onStreamWindowStart: (windowStart: number) => void;
  readonly onToggleStreamPayload: (eventId: string) => void;
}): React.ReactElement {
  const requestBlocks = props.detail.blocks.filter((block) => block.direction === "request");
  const responseBlocks = props.detail.blocks.filter((block) => block.direction === "response");
  const blockSectionsDefaultOpen = shouldAutoOpenBlockSections(requestBlocks, responseBlocks);
  const diffByBlockId = React.useMemo(() => {
    return new Map(props.diff.blocks.map((entry) => [entry.block.id, entry.classification]));
  }, [props.diff.blocks]);

  return (
    <>
      <InspectorAnchor id="summary">
        <SummaryPanel detail={props.detail} />
      </InspectorAnchor>
      <InspectorAnchor id="composition">
        <RequestCompositionPanel composition={props.detail.requestComposition} />
      </InspectorAnchor>
      <Section
        id="request-blocks"
        title="Request Blocks"
        meta={blockListMeta(requestBlocks)}
        defaultOpen={blockSectionsDefaultOpen}
      >
        <BlockToolbar filters={props.filters} onFilters={props.onFilters} />
        <BlockList blocks={requestBlocks} filterKind={props.filters.blockKind} diffByBlockId={diffByBlockId} />
      </Section>
      <Section
        id="response-blocks"
        title="Response Blocks"
        meta={blockListMeta(responseBlocks)}
        defaultOpen={blockSectionsDefaultOpen}
      >
        <BlockList blocks={responseBlocks} filterKind={props.filters.blockKind} diffByBlockId={diffByBlockId} />
      </Section>
      <Section id="diff" title="Diff Against Previous Request">
        <DiffPanel diff={props.diff} />
      </Section>
      <Section id="usage" title="Usage Records">
        <UsagePanel records={props.detail.usageRecords} />
      </Section>
      <Section id="network" title="Network Metadata">
        <NetworkPanel events={props.detail.httpEvents} />
      </Section>
      <Section id="stream" title="Stream Events">
        <StreamPanel
          streamState={props.streamState}
          count={props.detail.summary.streamEventCount}
          onLoad={props.onLoadStream}
          onLoadMore={props.onLoadMoreStream}
          onWindowStart={props.onStreamWindowStart}
          onTogglePayload={props.onToggleStreamPayload}
        />
      </Section>
      <Section id="raw" title="Raw Payloads">
        <RawPayloadPanel rawPayloads={props.detail.rawPayloads} rawPayloadCount={props.detail.summary.rawPayloadCount} />
      </Section>
      <Section id="health" title="Health">
        <HealthPanel health={props.health} />
      </Section>
    </>
  );
}

function InspectorSectionNav(): React.ReactElement {
  return (
    <nav className="mt-3 flex gap-1 overflow-x-auto pb-0.5" aria-label="Inspector sections" data-testid="inspector-section-nav">
      {INSPECTOR_SECTIONS.map((section) => (
        <button
          key={section.id}
          type="button"
          className="shrink-0 rounded-md border border-stone-200 bg-stone-50 px-2.5 py-1 text-xs font-medium text-stone-700 transition-colors hover:border-stone-400 hover:bg-stone-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600 focus-visible:ring-offset-2"
          aria-label={`Jump to ${section.label}`}
          data-testid={`inspector-nav-${section.id}`}
          onClick={() => {
            scrollInspectorSection(section.id);
          }}
        >
          {section.label}
        </button>
      ))}
    </nav>
  );
}

function InspectorAnchor(props: {
  readonly id: InspectorSectionId;
  readonly children: React.ReactNode;
}): React.ReactElement {
  return (
    <section id={inspectorSectionDomId(props.id)} className="scroll-mt-36" data-testid={`inspector-section-${props.id}`}>
      {props.children}
    </section>
  );
}

function scrollInspectorSection(id: InspectorSectionId): void {
  const target = document.getElementById(inspectorSectionDomId(id));
  if (target instanceof HTMLDetailsElement) {
    target.open = true;
  }
  target?.scrollIntoView({ block: "start" });
}

function resetInspectorScroll(): void {
  window.requestAnimationFrame(() => {
    const inspector = document.querySelector("aside");
    if (inspector instanceof HTMLElement) {
      inspector.scrollTop = 0;
    }
  });
}

function inspectorSectionDomId(id: InspectorSectionId): string {
  return `spy-inspector-${id}`;
}

function streamWindowStartForIndex(index: number, itemCount: number): number {
  if (itemCount <= STREAM_EVENT_WINDOW_SIZE) {
    return 0;
  }
  return Math.min(Math.max(0, index), itemCount - STREAM_EVENT_WINDOW_SIZE);
}

function shouldAutoOpenBlockSections(
  requestBlocks: readonly NormalizedBlock[],
  responseBlocks: readonly NormalizedBlock[],
): boolean {
  const blocks = [...requestBlocks, ...responseBlocks];
  const byteSize = blocks.reduce((total, block) => total + block.byte_size, 0);
  return blocks.length <= BLOCK_SECTION_AUTO_OPEN_MAX_BLOCKS && byteSize <= BLOCK_SECTION_AUTO_OPEN_MAX_BYTES;
}

function blockListMeta(blocks: readonly NormalizedBlock[]): string {
  const byteSize = blocks.reduce((total, block) => total + block.byte_size, 0);
  return `${formatNumber(blocks.length)} ${blocks.length === 1 ? "block" : "blocks"} · ${formatBytes(byteSize)}`;
}

function SummaryPanel(props: { readonly detail: SpyCallDetail }): React.ReactElement {
  const { summary } = props.detail;
  return (
    <div className="rounded-md border border-stone-300 bg-white p-4 shadow-sm">
      <div className="grid grid-cols-4 gap-3">
        <PanelMetric icon={<Clock aria-hidden="true" size={16} />} label="Started" value={formatDateTime(summary.call.started_at)} />
        <PanelMetric icon={<Activity aria-hidden="true" size={16} />} label="Duration" value={formatDuration(summary.durationMs)} />
        <PanelMetric icon={<Database aria-hidden="true" size={16} />} label="Request" value={formatBytes(summary.requestByteSize)} />
        <PanelMetric icon={<BadgeInfo aria-hidden="true" size={16} />} label="Total Usage" value={formatUsageTotal(summary.usage)} />
      </div>
    </div>
  );
}

function PanelMetric(props: {
  readonly icon: React.ReactNode;
  readonly label: string;
  readonly value: string;
}): React.ReactElement {
  return (
    <div className="min-w-0 rounded-md border border-stone-200 bg-stone-50 p-3">
      <div className="flex items-center gap-2 text-xs text-stone-500">
        {props.icon}
        {props.label}
      </div>
      <div className="mt-1 truncate text-sm font-semibold text-stone-950">{props.value}</div>
    </div>
  );
}

function RequestCompositionPanel(props: {
  readonly composition: SpyRequestComposition;
}): React.ReactElement {
  const { composition } = props;
  return (
    <div className="rounded-md border border-stone-300 bg-white p-4 shadow-sm" data-testid="request-composition">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">Request Composition</h3>
        <Badge tone="neutral">request only</Badge>
      </div>

      <div className="mt-3 grid grid-cols-4 gap-x-4 gap-y-3 border-y border-stone-200 py-3">
        <CompositionMetric label="Messages" value={formatNumber(composition.totalMessageCount)} />
        <CompositionMetric label="Blocks" value={formatNumber(composition.totalBlockCount)} />
        <CompositionMetric label="Characters" value={formatNumber(composition.totalCharSize)} />
        <CompositionMetric label="Bytes" value={formatBytes(composition.totalByteSize)} />
        <CompositionMetric
          label="Tool schemas"
          value={`${formatNumber(composition.toolDefinitionCount)} · ${formatBytes(composition.toolSchemaByteSize)}`}
          detail={`${formatNumber(composition.toolSchemaCharSize)} chars`}
        />
        <CompositionMetric
          label="Cache markers"
          value={`${formatNumber(composition.cacheMarkerCount)} · ${formatBytes(composition.cacheMarkerByteSize)}`}
          detail={`${formatNumber(composition.cacheMarkerCharSize)} chars`}
        />
        <CompositionMetric
          label="Media summaries"
          value={`${formatNumber(composition.mediaSummaryCount)} · ${formatBytes(composition.mediaSummaryByteSize)}`}
          detail={`${formatNumber(composition.mediaSummaryCharSize)} chars`}
        />
        <CompositionMetric
          label="Provider usage"
          value={formatUsageTotal(composition.usage)}
          detail={formatCompositionUsageDetail(composition.usage)}
        />
      </div>

      <div className="mt-3 overflow-hidden rounded-md border border-stone-200 text-xs">
        <div className="grid grid-cols-[minmax(150px,1fr)_72px_72px_72px_88px_88px] gap-2 bg-stone-100 px-3 py-2 font-medium text-stone-600">
          <span>Section</span>
          <span>State</span>
          <span className="text-right">Messages</span>
          <span className="text-right">Blocks</span>
          <span className="text-right">Chars</span>
          <span className="text-right">Bytes</span>
        </div>
        {composition.sections.map((section) => (
          <div key={section.kind} className="grid grid-cols-[minmax(150px,1fr)_72px_72px_72px_88px_88px] gap-2 border-t border-stone-200 px-3 py-2">
            <span className="truncate font-medium text-stone-800">{blockKindLabel(section.kind)}</span>
            <span className={section.present ? "text-emerald-700" : "text-stone-400"}>
              {section.present ? "present" : "absent"}
            </span>
            <span className="text-right text-stone-600">{formatNumber(section.messageCount)}</span>
            <span className="text-right text-stone-600">{formatNumber(section.blockCount)}</span>
            <span className="text-right text-stone-600">{formatNumber(section.charSize)}</span>
            <span className="text-right text-stone-600">{formatBytes(section.byteSize)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function CompositionMetric(props: {
  readonly label: string;
  readonly value: string;
  readonly detail?: string | undefined;
}): React.ReactElement {
  return (
    <div className="min-w-0">
      <div className="truncate text-xs text-stone-500">{props.label}</div>
      <div className="mt-0.5 truncate text-sm font-semibold text-stone-950">{props.value}</div>
      {props.detail === undefined ? null : <div className="mt-0.5 truncate text-xs text-stone-500">{props.detail}</div>}
    </div>
  );
}

function formatCompositionUsageDetail(usage: SpyRequestComposition["usage"]): string {
  return [
    `in ${formatNumber(usage.inputTokens)}`,
    `out ${formatNumber(usage.outputTokens)}`,
    `cache ${formatNumber(usage.cacheReadTokens)}/${formatNumber(usage.cacheWriteTokens)}`,
  ].join(" · ");
}

function BlockToolbar(props: {
  readonly filters: UiFilters;
  readonly onFilters: (filters: UiFilters) => void;
}): React.ReactElement {
  const kinds: readonly NormalizedBlock["kind"][] = [
    "provider-envelope",
    "harness-system-context",
    "user-visible-message",
    "prior-conversation-history",
    "current-user-input",
    "assistant-output",
    "thinking",
    "tool-definition",
    "tool-call",
    "tool-result",
    "cache-marker",
    "media-summary",
    "unknown",
  ];
  return (
    <div className="mb-3 flex items-center justify-end">
      <Select
        aria-label="Filter blocks by kind"
        value={props.filters.blockKind}
        onChange={(event) => {
          props.onFilters({ ...props.filters, blockKind: event.target.value });
        }}
      >
        <option value={ALL_FILTER}>All block kinds</option>
        {kinds.map((kind) => (
          <option key={kind} value={kind}>{blockKindLabel(kind)}</option>
        ))}
      </Select>
    </div>
  );
}

function BlockList(props: {
  readonly blocks: readonly NormalizedBlock[];
  readonly filterKind: string;
  readonly diffByBlockId: ReadonlyMap<string, DiffClassification>;
}): React.ReactElement {
  const blocks = props.filterKind === ALL_FILTER
    ? props.blocks
    : props.blocks.filter((block) => block.kind === props.filterKind);
  if (blocks.length === 0) {
    return <div className="rounded-md border border-stone-200 bg-stone-50 p-3 text-sm text-stone-500">No blocks.</div>;
  }
  return (
    <div className="space-y-2">
      {blocks.map((block) => (
        <BlockRow key={block.id} block={block} diff={props.diffByBlockId.get(block.id)} />
      ))}
    </div>
  );
}

function BlockRow(props: {
  readonly block: NormalizedBlock;
  readonly diff: DiffClassification | undefined;
}): React.ReactElement {
  const text = blockText(props.block);
  return (
    <div className={cn("rounded-md border bg-white p-3", blockBorderClass(props.block.kind))}>
      <div className="flex items-center gap-2">
        <Badge tone={blockTone(props.block.kind)}>{blockKindLabel(props.block.kind)}</Badge>
        {props.block.role === undefined ? null : <Badge>{props.block.role}</Badge>}
        {props.block.cache_marker ? <Badge tone="blue">cache marker</Badge> : null}
        {props.diff === undefined ? null : <Badge tone={diffTone(props.diff)}>{props.diff}</Badge>}
        <span className="ml-auto text-xs text-stone-500">{formatBytes(props.block.byte_size)}</span>
      </div>
      {text.length === 0 ? null : (
        <pre className="spy-scrollbar mt-3 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-stone-950 p-3 text-xs leading-5 text-stone-50">
          {clipped(text, 6_000)}
        </pre>
      )}
      <div className="mt-2 truncate text-xs text-stone-500">{props.block.provider_path ?? props.block.source}</div>
    </div>
  );
}

function DiffPanel(props: { readonly diff: SpyCallDiff }): React.ReactElement {
  const previous = props.diff.previousCall;
  const counts = props.diff.blocks.reduce<Record<DiffClassification, number>>((current, entry) => {
    current[entry.classification] += 1;
    return current;
  }, { new: 0, repeated: 0, changed: 0, unknown: 0 });
  return (
    <div className="space-y-3">
      <div className="text-sm text-stone-600">
        Previous comparable request: {previous === null ? "none" : `${formatDateTime(previous.call.started_at)} · ${previous.call.id}`}
      </div>
      <div className="grid grid-cols-4 gap-2">
        {(["new", "changed", "repeated", "unknown"] as const).map((classification) => (
          <div key={classification} className="rounded-md border border-stone-200 bg-stone-50 px-3 py-2">
            <div className="text-xs text-stone-500">{classification}</div>
            <div className="text-lg font-semibold">{formatNumber(counts[classification])}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function UsagePanel(props: { readonly records: readonly UsageRecord[] }): React.ReactElement {
  if (props.records.length === 0) {
    return <div className="text-sm text-stone-500">No provider usage record.</div>;
  }
  return (
    <div className="space-y-2">
      {props.records.map((record) => (
        <div key={record.id} className="grid grid-cols-5 gap-2 rounded-md border border-stone-200 bg-stone-50 p-3 text-sm">
          <UsageCell label="input" value={record.input_tokens} />
          <UsageCell label="output" value={record.output_tokens} />
          <UsageCell label="cache read" value={record.cache_read_tokens} />
          <UsageCell label="cache write" value={record.cache_write_tokens} />
          <UsageCell label="total" value={record.total_tokens} />
        </div>
      ))}
    </div>
  );
}

function UsageCell(props: { readonly label: string; readonly value: number | undefined }): React.ReactElement {
  return (
    <div className="min-w-0">
      <div className="truncate text-xs text-stone-500">{props.label}</div>
      <div className="truncate font-semibold">{formatNumber(props.value)}</div>
    </div>
  );
}

function NetworkPanel(props: { readonly events: readonly HttpEventRecord[] }): React.ReactElement {
  return (
    <div className="space-y-3">
      {props.events.map((event) => (
        <div key={event.id} className="rounded-md border border-stone-200 bg-stone-50 p-3">
          <div className="flex items-center gap-2">
            <Badge tone={event.direction === "request" ? "teal" : "green"}>{event.direction}</Badge>
            <span className="truncate text-sm font-medium">{event.method} {event.path}</span>
            <span className="ml-auto text-xs text-stone-500">{event.status_code ?? ""} {event.reason ?? ""}</span>
          </div>
          <div className="mt-2 truncate text-xs text-stone-500">{event.host} · {formatDateTime(event.observed_at)}</div>
          <HeaderList headers={event.headers} />
        </div>
      ))}
    </div>
  );
}

function HeaderList(props: { readonly headers: readonly (readonly [string, string])[] }): React.ReactElement {
  return (
    <div className="mt-3 grid grid-cols-[170px_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-md bg-white p-2 text-xs">
      {props.headers.map(([name, value]) => (
        <React.Fragment key={`${name}:${value}`}>
          <span className="truncate font-medium text-stone-600">{name}</span>
          <span className="truncate text-stone-500">{value}</span>
        </React.Fragment>
      ))}
    </div>
  );
}

function StreamPanel(props: {
  readonly streamState: StreamState | null;
  readonly count: number;
  readonly onLoad: () => void;
  readonly onLoadMore: () => void;
  readonly onWindowStart: (windowStart: number) => void;
  readonly onTogglePayload: (eventId: string) => void;
}): React.ReactElement {
  if (props.streamState === null) {
    return (
      <div className="flex items-center justify-between rounded-md border border-stone-200 bg-stone-50 p-3">
        <span className="text-sm text-stone-600">{formatNumber(props.count)} stream events</span>
        <Button size="sm" onClick={props.onLoad}>Load Stream Events</Button>
      </div>
    );
  }
  if (props.streamState.state === "error") {
    return <ErrorPanel message={props.streamState.error ?? "failed to load stream events"} />;
  }
  const streamState = props.streamState;
  const loadedCount = streamState.items.length;
  const windowStart = streamWindowStartForIndex(streamState.windowStart, loadedCount);
  const visibleEvents = streamState.items.slice(windowStart, windowStart + STREAM_EVENT_WINDOW_SIZE);
  const windowEnd = windowStart + visibleEvents.length;
  if (loadedCount === 0) {
    return (
      <div className="space-y-3">
        {props.streamState.state === "loading" ? <LoadingPanel label="Loading stream events" /> : null}
        <div className="rounded-md border border-stone-200 bg-stone-50 p-3 text-sm text-stone-500">
          No stream events loaded.
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-3" data-testid="stream-event-window">
      <div className="flex flex-wrap items-center gap-2 rounded-md border border-stone-200 bg-stone-50 p-3">
        <div className="min-w-0 flex-1 text-sm text-stone-600">
          Loaded {formatNumber(loadedCount)} of {formatNumber(props.count)} stream events
          <span className="block text-xs text-stone-500">
            Showing {formatNumber(windowStart + 1)}-{formatNumber(windowEnd)}
          </span>
        </div>
        <Button
          size="sm"
          disabled={windowStart === 0}
          onClick={() => {
            props.onWindowStart(windowStart - STREAM_EVENT_WINDOW_SIZE);
          }}
        >
          Previous Events
        </Button>
        <Button
          size="sm"
          disabled={windowEnd >= loadedCount}
          onClick={() => {
            props.onWindowStart(windowStart + STREAM_EVENT_WINDOW_SIZE);
          }}
        >
          Next Events
        </Button>
        <Button
          size="sm"
          disabled={streamState.nextCursor === undefined || streamState.state === "loading"}
          onClick={props.onLoadMore}
        >
          {streamState.state === "loading" ? "Loading Stream Events" : "Load More Stream Events"}
        </Button>
      </div>
      {visibleEvents.map((event) => (
        <StreamEventRow
          key={event.id}
          event={event}
          expanded={streamState.expandedEventId === event.id}
          onToggle={() => {
            props.onTogglePayload(event.id);
          }}
        />
      ))}
    </div>
  );
}

function StreamEventRow(props: {
  readonly event: StreamEvent;
  readonly expanded: boolean;
  readonly onToggle: () => void;
}): React.ReactElement {
  const payloadText = streamEventPayloadText(props.event);
  const headerEventType = props.event.headers[":event-type"];
  const eventSummary = props.event.payload_sha256 ?? (typeof headerEventType === "string" ? headerEventType : "stream event");
  return (
    <div className="rounded-md border border-stone-200 bg-stone-50 p-3" data-testid="stream-event-card">
      <div className="flex min-w-0 items-center gap-2">
        <Badge tone="blue">{props.event.event_type}</Badge>
        <span className="text-xs text-stone-500">#{formatNumber(props.event.ordinal)}</span>
        <span className="min-w-0 truncate text-xs text-stone-500">
          {eventSummary}
        </span>
        <Button className="ml-auto" size="sm" onClick={props.onToggle}>
          {props.expanded ? "Hide Payload" : "Show Payload"}
        </Button>
      </div>
      {props.expanded ? (
        <pre className="mt-2 whitespace-pre-wrap break-words rounded-md bg-white p-3 text-xs text-stone-700" data-testid="stream-event-payload">
          {clipped(payloadText, STREAM_EVENT_PAYLOAD_PREVIEW_CHARS)}
        </pre>
      ) : null}
    </div>
  );
}

function streamEventPayloadText(event: StreamEvent): string {
  return JSON.stringify(event.payload ?? event.payload_text ?? event.headers, null, 2);
}

function RawPayloadPanel(props: {
  readonly rawPayloads: readonly RawPayloadRecord[];
  readonly rawPayloadCount: number;
}): React.ReactElement {
  if (props.rawPayloads.length === 0) {
    return <div className="text-sm text-stone-500">Raw storage disabled or no raw payloads stored for this call.</div>;
  }
  return (
    <div className="space-y-2">
      {props.rawPayloads.map((payload) => (
        <div key={payload.id} className="rounded-md border border-stone-200 bg-stone-50 p-3">
          <div className="flex items-center gap-2">
            <Badge tone={payload.direction === "request" ? "teal" : "green"}>{payload.direction}</Badge>
            <span className="text-xs text-stone-500">{payload.content_type ?? payload.body_encoding ?? "payload"} · {payload.body_sha256 ?? "no hash"}</span>
          </div>
          {payload.body_text === undefined ? (
            <div className="mt-2 text-xs text-stone-500">base64 payload · {payload.body_b64 === undefined ? "not available" : `${formatNumber(payload.body_b64.length)} encoded chars`}</div>
          ) : (
            <pre className="spy-scrollbar mt-2 max-h-52 overflow-auto whitespace-pre-wrap break-words rounded-md bg-white p-3 text-xs text-stone-700">
              {clipped(payload.body_text, 4_000)}
            </pre>
          )}
        </div>
      ))}
      <div className="text-xs text-stone-500">Stored payload records: {formatNumber(props.rawPayloadCount)}</div>
    </div>
  );
}

function HealthPanel(props: { readonly health: SpyServiceHealth | null }): React.ReactElement {
  if (props.health === null) {
    return <div className="text-sm text-stone-500">Health unavailable.</div>;
  }
  const { service, store } = props.health;
  return (
    <div className="grid grid-cols-3 gap-2 text-sm">
      <HealthCell label="Enabled" value={service.enabled ? "Enabled" : "Disabled"} />
      <HealthCell label="DB size" value={formatBytes(store.dbSizeBytes)} />
      <HealthCell label="Spool size" value={formatBytes(store.spoolSizeBytes)} />
      <HealthCell label="Store cap" value={formatBytes(service.maxBytes)} />
      <HealthCell label="Spool cap" value={formatBytes(service.spoolMaxBytes)} />
      <HealthCell label="Retention" value={`${formatNumber(service.retentionDays)} days`} />
      <HealthCell label="Dropped captures" value={formatNumber(store.droppedCaptureCount)} />
      <HealthCell label="Last ingest" value={store.lastIngestAt === null ? "-" : formatDateTime(store.lastIngestAt)} />
      <HealthCell label="Calls" value={formatNumber(store.providerCallCount)} />
      <HealthCell label="Pending" value={formatNumber(store.pendingCallCount)} />
      <HealthCell label="Schema" value={formatNumber(store.schemaVersion)} />
    </div>
  );
}

function HealthCell(props: { readonly label: string; readonly value: string }): React.ReactElement {
  return (
    <div className="min-w-0 rounded-md border border-stone-200 bg-stone-50 px-3 py-2">
      <div className="truncate text-xs text-stone-500">{props.label}</div>
      <div className="truncate font-semibold">{props.value}</div>
    </div>
  );
}

function Section(props: {
  readonly id: InspectorSectionId;
  readonly title: string;
  readonly meta?: string | undefined;
  readonly defaultOpen?: boolean | undefined;
  readonly children: React.ReactNode;
}): React.ReactElement {
  return (
    <details
      id={inspectorSectionDomId(props.id)}
      className="scroll-mt-36 rounded-md border border-stone-300 bg-white shadow-sm"
      data-testid={`inspector-section-${props.id}`}
      open={props.defaultOpen}
    >
      <summary className="flex cursor-pointer select-none items-center gap-3 px-4 py-3 text-sm font-semibold text-stone-900">
        <span>{props.title}</span>
        {props.meta === undefined ? null : (
          <span className="ml-auto text-xs font-medium text-stone-500">{props.meta}</span>
        )}
      </summary>
      <div className="border-t border-stone-200 p-4">{props.children}</div>
    </details>
  );
}

function EmptyInspector(props: { readonly health: SpyServiceHealth | null }): React.ReactElement {
  return (
    <>
      <div className="rounded-md border border-stone-300 bg-white p-6 text-sm text-stone-500">
        Select a timeline row to inspect the provider call.
      </div>
      <section className="rounded-md border border-stone-300 bg-white p-4 shadow-sm" data-testid="inspector-health-standalone">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold text-stone-900">Service Health</h3>
          <Badge tone="neutral">service</Badge>
        </div>
        <HealthPanel health={props.health} />
      </section>
    </>
  );
}

function LoadingPanel(props: { readonly label: string }): React.ReactElement {
  return (
    <div className="flex items-center gap-2 rounded-md border border-stone-300 bg-white p-4 text-sm text-stone-600">
      <Loader2 aria-hidden="true" className="animate-spin" size={16} />
      {props.label}
    </div>
  );
}

function ErrorPanel(props: { readonly message: string }): React.ReactElement {
  return (
    <div className="flex items-center gap-2 rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-800">
      <AlertTriangle aria-hidden="true" size={16} />
      {props.message}
    </div>
  );
}

function ClearDialog(props: {
  readonly clearing: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}): React.ReactElement {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-950/40 p-6" role="dialog" aria-modal="true" aria-labelledby="clear-title">
      <div className="w-full max-w-md rounded-md border border-stone-300 bg-white p-5 shadow-xl">
        <h2 id="clear-title" className="text-base font-semibold">Clear Spy Data</h2>
        <p className="mt-2 text-sm text-stone-600">
          Captured calls and pending spool files will be deleted. Schema metadata is kept.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <Button onClick={props.onCancel}>Cancel</Button>
          <Button variant="danger" disabled={props.clearing} onClick={props.onConfirm}>
            {props.clearing ? <Loader2 aria-hidden="true" className="animate-spin" size={15} /> : <Trash2 aria-hidden="true" size={15} />}
            Clear
          </Button>
        </div>
      </div>
    </div>
  );
}

function blockTone(kind: NormalizedBlock["kind"]): "neutral" | "green" | "amber" | "red" | "blue" | "teal" {
  if (kind === "current-user-input" || kind === "user-visible-message") {
    return "teal";
  }
  if (kind === "assistant-output") {
    return "green";
  }
  if (kind === "thinking" || kind === "cache-marker") {
    return "blue";
  }
  if (kind === "tool-call" || kind === "tool-result" || kind === "tool-definition") {
    return "amber";
  }
  return "neutral";
}

function diffTone(diff: DiffClassification): "neutral" | "green" | "amber" | "blue" {
  if (diff === "new") {
    return "green";
  }
  if (diff === "changed") {
    return "amber";
  }
  if (diff === "repeated") {
    return "blue";
  }
  return "neutral";
}

function blockBorderClass(kind: NormalizedBlock["kind"]): string {
  if (kind === "current-user-input" || kind === "user-visible-message") {
    return "border-l-4 border-l-teal-600";
  }
  if (kind === "assistant-output") {
    return "border-l-4 border-l-emerald-600";
  }
  if (kind === "thinking" || kind === "cache-marker") {
    return "border-l-4 border-l-sky-600";
  }
  if (kind === "tool-call" || kind === "tool-result" || kind === "tool-definition") {
    return "border-l-4 border-l-amber-500";
  }
  return "border-stone-200";
}

function isRollingPreset(preset: TimePreset): boolean {
  return preset === "10m" || preset === "1h" || preset === "today";
}

function datetimeLocalValue(seconds: number): string {
  const date = new Date(seconds * 1000);
  const offsetMs = date.getTimezoneOffset() * 60 * 1000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

function secondsFromDatetimeLocal(value: string): number | null {
  const parsed = new Date(value);
  const ms = parsed.getTime();
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

function filterQueryValue(value: string): string | undefined {
  return value === ALL_FILTER ? undefined : value;
}

function timelineEmptyStateFor(search: string, filters: UiFilters): TimelineEmptyState {
  if (search.trim().length > 0) {
    return "query";
  }
  return filters.provider === ALL_FILTER
    && filters.model === ALL_FILTER
    && filters.operation === ALL_FILTER
    && filters.status === ALL_FILTER
    ? "range"
    : "query";
}

function sseErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `SSE validation failed: ${message}`;
}
