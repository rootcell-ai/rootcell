import { expect, type Page, type Route, test } from "@playwright/test";
import type {
  NormalizedBlock,
  SpyCallDetail,
  SpyCallDiff,
  SpyCallSummary,
  SpyRequestComposition,
  SpyServiceHealth,
  StreamEvent,
} from "../src/types.ts";

test.describe.configure({ mode: "serial" });

test("loads fixture calls and receives live updates", async ({ page }) => {
  await page.goto("/?since=0");
  await expect(page.getByRole("heading", { name: "Rootcell Spy" })).toBeVisible();
  await expect(page.getByTestId("timeline-row")).toHaveCount(4);
  await expect(page.getByTestId("timeline-row")).toHaveCount(5);
});

test("keeps timeline range state synchronized with the URL", async ({ page }) => {
  await page.goto("/?since=0");
  await expect(page.getByTestId("timeline-row")).toHaveCount(5);

  const initialState = await readRangeState(page);
  expect(initialState.subtitle).toContain("Since ");
  expect(initialState.activeButtons).toEqual([]);

  await page.getByRole("button", { name: "10 min" }).click();
  await expect(page.getByTestId("timeline-row")).toHaveCount(5);
  const tenMinuteState = await readRangeState(page);
  const tenMinuteUrl = new URL(page.url());
  expect(tenMinuteState.subtitle).toContain("Since ");
  expect(tenMinuteState.activeButtons).toEqual(["10 min"]);
  expect(tenMinuteUrl.searchParams.get("preset")).toBe("10m");
  expect(tenMinuteUrl.searchParams.has("since")).toBe(false);

  await page.reload();
  await expect(page.getByTestId("timeline-row")).toHaveCount(5);
  const reloadedState = await readRangeState(page);
  expect(reloadedState.subtitle).toContain("Since ");
  expect(reloadedState.activeButtons).toEqual(["10 min"]);

  await page.getByRole("button", { name: "Live" }).click();
  const liveUrl = new URL(page.url());
  expect(liveUrl.searchParams.get("preset")).toBe("live");
  expect(liveUrl.searchParams.has("since")).toBe(false);

  await page.reload();
  const liveState = await readRangeState(page);
  expect(liveState.subtitle).toBe("Live from now");
  expect(liveState.activeButtons).toEqual(["Live"]);
});

test("keeps relative time ranges rolling on refresh", async ({ page }) => {
  const callSinceValues: number[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname !== "/api/calls" && url.pathname !== "/api/search") {
      return;
    }
    const since = Number(url.searchParams.get("since"));
    if (Number.isFinite(since)) {
      callSinceValues.push(since);
    }
  });

  await page.goto("/?since=0");
  await expect(page.getByTestId("timeline-row")).toHaveCount(5);
  await page.getByRole("button", { name: "10 min" }).click();
  await expect.poll(() => callSinceValues.length).toBeGreaterThan(1);
  const firstTenMinuteSince = callSinceValues.at(-1);
  expect(firstTenMinuteSince).toBeDefined();
  const firstSubtitle = (await readRangeState(page)).subtitle;

  await page.waitForTimeout(2100);
  const requestsBeforeRefresh = callSinceValues.length;
  await page.getByLabel("Refresh calls").click();
  await expect.poll(() => callSinceValues.length).toBeGreaterThan(requestsBeforeRefresh);

  const refreshedTenMinuteSince = callSinceValues.at(-1);
  expect(refreshedTenMinuteSince).toBeDefined();
  expect(refreshedTenMinuteSince).toBeGreaterThan(firstTenMinuteSince ?? 0);
  const refreshedState = await readRangeState(page);
  expect(refreshedState.activeButtons).toEqual(["10 min"]);
  expect(refreshedState.subtitle).not.toBe(firstSubtitle);

  const url = new URL(page.url());
  expect(url.searchParams.get("preset")).toBe("10m");
  expect(url.searchParams.has("since")).toBe(false);
});

test("keeps timeline and inspector scroll containers inside the viewport", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/?since=0");
  await expect(page.getByTestId("timeline-row")).toHaveCount(5);

  const initialMetrics = await page.evaluate(() => {
    const rectOf = (selector: string): DOMRect => {
      const element = document.querySelector(selector);
      if (element === null) {
        throw new Error(`missing ${selector}`);
      }
      return element.getBoundingClientRect();
    };
    const main = document.querySelector("main");
    const timeline = document.querySelector('[data-testid="timeline"]');
    const aside = document.querySelector("aside");
    if (main === null || timeline === null || aside === null) {
      throw new Error("missing layout containers");
    }

    const timelineRect = rectOf('[data-testid="timeline"]');
    const asideRect = rectOf("aside");
    return {
      viewportHeight: window.innerHeight,
      mainClientHeight: main.clientHeight,
      mainScrollHeight: main.scrollHeight,
      timelineBottom: timelineRect.bottom,
      timelineClientHeight: timeline.clientHeight,
      timelineScrollHeight: timeline.scrollHeight,
      asideBottom: asideRect.bottom,
      asideClientHeight: aside.clientHeight,
      asideScrollHeight: aside.scrollHeight,
    };
  });

  expect(initialMetrics.mainScrollHeight).toBe(initialMetrics.mainClientHeight);
  expect(initialMetrics.timelineBottom).toBeLessThanOrEqual(initialMetrics.viewportHeight);
  expect(initialMetrics.asideBottom).toBeLessThanOrEqual(initialMetrics.viewportHeight);
  expect(initialMetrics.timelineScrollHeight).toBeGreaterThan(initialMetrics.timelineClientHeight);
  expect(initialMetrics.asideScrollHeight).toBeGreaterThan(initialMetrics.asideClientHeight);

  const tailMetrics = await page.evaluate(() => {
    const aside = document.querySelector("aside");
    if (aside === null) {
      throw new Error("missing inspector");
    }
    aside.scrollTop = aside.scrollHeight;
    const healthSummary = Array.from(document.querySelectorAll("summary"))
      .find((summary) => summary.textContent.trim() === "Health");
    if (healthSummary === undefined) {
      throw new Error("missing health summary");
    }
    const healthRect = healthSummary.getBoundingClientRect();
    return {
      viewportHeight: window.innerHeight,
      healthTop: healthRect.top,
      healthBottom: healthRect.bottom,
      inspectorScrollTop: aside.scrollTop,
      inspectorMaxScrollTop: aside.scrollHeight - aside.clientHeight,
    };
  });

  expect(tailMetrics.inspectorScrollTop).toBe(tailMetrics.inspectorMaxScrollTop);
  expect(tailMetrics.healthTop).toBeGreaterThanOrEqual(0);
  expect(tailMetrics.healthBottom).toBeLessThanOrEqual(tailMetrics.viewportHeight);
});

test("keeps timeline rows and footer from overlapping", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 720 });
  await page.goto("/?since=0");
  await page.getByRole("button", { name: "10 min" }).click();
  await expect(page.getByTestId("timeline-row")).toHaveCount(5);

  await expect.poll(async () => page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('[data-testid="timeline-row"]'));
    const rects = rows.map((row) => row.getBoundingClientRect());
    let maxOverlap = 0;
    for (let index = 1; index < rects.length; index += 1) {
      const previous = rects[index - 1];
      const current = rects[index];
      if (previous !== undefined && current !== undefined) {
        maxOverlap = Math.max(maxOverlap, previous.bottom - current.top);
      }
    }
    return Math.max(0, Math.ceil(maxOverlap));
  })).toBe(0);

  const footerMetrics = await page.evaluate(async () => {
    const timeline = document.querySelector('[data-testid="timeline"]');
    const footer = document.querySelector('[data-testid="timeline-footer"]');
    if (timeline === null || footer === null) {
      throw new Error("missing timeline containers");
    }
    timeline.scrollTop = timeline.scrollHeight;
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        resolve();
      });
    });

    const footerRect = footer.getBoundingClientRect();
    const rowRects = Array.from(document.querySelectorAll('[data-testid="timeline-row"]'))
      .map((row) => row.getBoundingClientRect());
    const maxFooterOverlap = rowRects.reduce((maxOverlap, rowRect) => {
      const overlap = Math.min(rowRect.bottom, footerRect.bottom) - Math.max(rowRect.top, footerRect.top);
      return Math.max(maxOverlap, overlap);
    }, 0);
    return {
      footerTop: footerRect.top,
      maxFooterOverlap: Math.max(0, Math.ceil(maxFooterOverlap)),
      timelineScrollTop: timeline.scrollTop,
      timelineMaxScrollTop: timeline.scrollHeight - timeline.clientHeight,
    };
  });

  expect(footerMetrics.timelineScrollTop).toBe(footerMetrics.timelineMaxScrollTop);
  expect(footerMetrics.maxFooterOverlap).toBe(0);
});

test("selects a call and opens inspector sections", async ({ page }) => {
  await page.goto("/?since=0");
  await expect(page.getByTestId("timeline-row")).toHaveCount(5);
  await page.getByTestId("timeline-row").first().click();
  await expect(page.getByTestId("request-composition")).toBeVisible();
  await expect(page.getByTestId("request-composition").getByText("Messages", { exact: true }).first()).toBeVisible();
  await expect(page.getByTestId("request-composition").getByText("Tool schemas", { exact: true })).toBeVisible();
  await expect(page.getByTestId("request-composition").getByText("Cache markers", { exact: true })).toBeVisible();
  await expect(page.getByTestId("request-composition").getByText("Media summaries", { exact: true })).toBeVisible();
  await expect(page.getByTestId("request-composition").getByText("Provider usage", { exact: true })).toBeVisible();
  await expect(page.getByTestId("request-composition").getByText("Current User Input", { exact: true })).toBeVisible();
  await expect(page.getByText("Request Blocks", { exact: true })).toBeVisible();
  await expect(page.getByText("Network Metadata", { exact: true })).toBeVisible();
  await page.getByTestId("inspector-nav-health").click();
  await expect(page.getByText("Enabled", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("DB size", { exact: true })).toBeVisible();
  await expect(page.getByText("Spool size", { exact: true })).toBeVisible();
  await expect(page.getByText("Store cap", { exact: true })).toBeVisible();
  await expect(page.getByText("Spool cap", { exact: true })).toBeVisible();
  await expect(page.getByText("Retention", { exact: true })).toBeVisible();
  await expect(page.getByText("Dropped captures", { exact: true })).toBeVisible();
  await expect(page.getByText("Last ingest", { exact: true })).toBeVisible();
});

test("shows pinned inspector state when a newer visible call is available", async ({ page }) => {
  await page.goto("/?since=0");
  await expect(page.getByTestId("timeline-row")).toHaveCount(5);
  await expect(page.getByTestId("inspector-pinned-state")).toHaveCount(0);

  await page.getByRole("button", { name: "Open call call-fixture-flow-tool-use", exact: true }).click();
  await expect(page.locator("aside").getByText("call-fixture-flow-tool-use", { exact: true })).toBeVisible();
  await expect(page.getByTestId("inspector-pinned-state")).toHaveText("Pinned");
  await expect(page.getByRole("button", { name: "Follow Latest", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Follow Latest", exact: true }).click();
  await expect(page.locator("aside").getByText("call-fixture-flow-tool-result", { exact: true })).toBeVisible();
  await expect(page.getByTestId("inspector-pinned-state")).toHaveCount(0);
});

test("jumps to buried inspector sections from the section navigator", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/?since=0");
  await expect(page.getByTestId("timeline-row")).toHaveCount(5);
  await page.getByTestId("timeline-row").first().click();
  await expect(page.getByTestId("inspector-section-nav")).toBeVisible();

  const initialMetrics = await page.evaluate(() => {
    const aside = document.querySelector("aside");
    const requestBlocks = document.querySelector('[data-testid="inspector-section-request-blocks"]');
    const responseBlocks = document.querySelector('[data-testid="inspector-section-response-blocks"]');
    const health = document.querySelector('[data-testid="inspector-section-health"]');
    if (aside === null || requestBlocks === null || responseBlocks === null || health === null) {
      throw new Error("missing inspector section");
    }
    return {
      viewportHeight: window.innerHeight,
      requestBlocksOpen: requestBlocks.hasAttribute("open"),
      responseBlocksOpen: responseBlocks.hasAttribute("open"),
      healthTop: health.getBoundingClientRect().top,
      asideScrollTop: aside.scrollTop,
      mainScrollTop: document.querySelector("main")?.scrollTop,
    };
  });

  expect(initialMetrics.requestBlocksOpen).toBe(false);
  expect(initialMetrics.responseBlocksOpen).toBe(false);
  expect(initialMetrics.healthTop).toBeGreaterThan(initialMetrics.viewportHeight);
  expect(initialMetrics.asideScrollTop).toBe(0);
  expect(initialMetrics.mainScrollTop).toBe(0);

  await page.getByTestId("inspector-nav-health").click();

  const jumpedMetrics = await page.evaluate(() => {
    const aside = document.querySelector("aside");
    const main = document.querySelector("main");
    const header = document.querySelector("header");
    const health = document.querySelector('[data-testid="inspector-section-health"]');
    if (aside === null || main === null || header === null || health === null) {
      throw new Error("missing layout element");
    }
    const healthRect = health.getBoundingClientRect();
    const headerRect = header.getBoundingClientRect();
    return {
      viewportHeight: window.innerHeight,
      asideScrollTop: aside.scrollTop,
      mainScrollTop: main.scrollTop,
      headerTop: headerRect.top,
      headerBottom: headerRect.bottom,
      healthTop: healthRect.top,
      healthBottom: healthRect.bottom,
    };
  });

  expect(jumpedMetrics.asideScrollTop).toBeGreaterThan(0);
  expect(jumpedMetrics.mainScrollTop).toBe(0);
  expect(jumpedMetrics.headerTop).toBe(0);
  expect(jumpedMetrics.headerBottom).toBeGreaterThan(0);
  expect(jumpedMetrics.healthTop).toBeGreaterThanOrEqual(jumpedMetrics.headerBottom);
  expect(jumpedMetrics.healthTop).toBeLessThan(jumpedMetrics.viewportHeight);
  expect(jumpedMetrics.healthBottom).toBeLessThanOrEqual(jumpedMetrics.viewportHeight);
});

test("loads historical ranges and searches text plus visible identifiers", async ({ page }) => {
  await page.goto("/?since=0");
  await page.getByRole("button", { name: "10 min" }).click();
  await expect(page.getByTestId("timeline-row").first()).toBeVisible();
  await expect(page.getByPlaceholder("Search text, call ID, or model")).toBeVisible();
  await page.getByLabel("Filter by provider").selectOption("bedrock");
  await page.getByLabel("Filter by operation").selectOption("invoke");
  await expect(page.getByText("No provider calls match the current search or filters.")).toBeVisible();
  await expect(page.getByText("No provider calls in this range.")).toHaveCount(0);
  await page.getByLabel("Search text, call ID, or model").fill("Fixture capture");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.getByText("No provider calls match the current search or filters.")).toBeVisible();
  await expect(page.getByText("No provider calls in this range.")).toHaveCount(0);
  await page.getByLabel("Filter by operation").selectOption("converse-stream");
  await expect(page.getByTestId("timeline-row").first()).toBeVisible();
  await page.getByLabel("Search text, call ID, or model").fill("call-fixture-flow-tool-result");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.getByTestId("timeline-row")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Open call call-fixture-flow-tool-result", exact: true })).toBeVisible();
  await page.getByLabel("Search text, call ID, or model").fill("sonnet");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.getByTestId("timeline-row")).toHaveCount(5);
});

test("labels diff baselines outside the current range", async ({ page }) => {
  await installDiffScopeRoutes(page);
  await page.goto("/?preset=custom&since=2000");

  await expect(page.getByTestId("timeline-row")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Open call call-diff-scope-current", exact: true })).toBeVisible();
  await page.getByTestId("inspector-nav-diff").click();

  const diffSection = page.getByTestId("inspector-section-diff");
  await expect(diffSection).toBeVisible();
  await expect(diffSection.getByText("Previous comparable request:", { exact: false })).toBeVisible();
  await expect(diffSection.getByText("call-diff-scope-previous", { exact: false })).toBeVisible();
  await expect(diffSection.getByText("outside current range", { exact: true })).toBeVisible();
  await expect(diffSection.getByText("Diff baseline is global across stored comparable calls, not scoped to the visible timeline.", { exact: true })).toBeVisible();
});

test("shows provider cache token classes in timeline rows", async ({ page }) => {
  await installCacheTimelineRoutes(page);
  await page.goto("/?since=0");

  const row = page.getByRole("button", { name: `Open call ${CACHE_TIMELINE_CALL_ID}`, exact: true });
  await expect(row).toBeVisible();
  await expect(row.getByText("read", { exact: true })).toBeVisible();
  await expect(row.getByText("10", { exact: true })).toBeVisible();
  await expect(row.getByText("write", { exact: true })).toBeVisible();
  await expect(row.getByText("98", { exact: true })).toBeVisible();
  await expect(row.getByText("cache read", { exact: true })).toBeVisible();
  await expect(row.getByText("5,200", { exact: true })).toBeVisible();
  await expect(row.getByText("cache write", { exact: true })).toBeVisible();
  await expect(row.getByText("81", { exact: true })).toBeVisible();
  await expect(row).not.toContainText("usage");
  await expect(row).not.toContainText("tok");
  await expect(row).not.toContainText("cache 2");
});

test("keeps service health visible when filters leave no selected call", async ({ page }) => {
  await page.goto("/?since=0");
  await expect(page.getByTestId("timeline-row")).toHaveCount(5);

  await page.getByLabel("Filter by status").selectOption("pending");

  await expect(page.getByTestId("timeline-row")).toHaveCount(0);
  await expect(page.getByText("No provider calls match the current search or filters.")).toBeVisible();
  await expect(page.getByText("No provider calls in this range.")).toHaveCount(0);
  await expect(page.getByTestId("inspector-section-nav")).toHaveCount(0);

  const inspector = page.locator("aside");
  await expect(inspector.getByText("Select a timeline row to inspect the provider call.", { exact: true })).toBeVisible();
  await expect(inspector.getByTestId("inspector-health-standalone")).toBeVisible();
  await expect(inspector.getByText("Service Health", { exact: true })).toBeVisible();
  await expect(inspector.getByText("Enabled", { exact: true }).first()).toBeVisible();
  await expect(inspector.getByText("DB size", { exact: true })).toBeVisible();
  await expect(inspector.getByText("Spool size", { exact: true })).toBeVisible();
  await expect(inspector.getByText("Calls", { exact: true })).toBeVisible();
  await expect(inspector.getByText("Pending", { exact: true })).toBeVisible();
  await expect(inspector.getByText("Schema", { exact: true })).toBeVisible();
});

test("loads stream events on demand", async ({ page }) => {
  await page.goto("/?since=0");
  await expect(page.getByTestId("timeline-row")).toHaveCount(5);
  await page.getByTestId("timeline-row").first().click();
  await page.getByText("Stream Events", { exact: true }).click();
  await page.getByRole("button", { name: "Load Stream Events" }).click();
  await expect(page.getByText("messageStart").first()).toBeVisible();
});

test("resets deep inspector state when reselecting the selected call", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/?since=0");
  await expect(page.getByTestId("timeline-row")).toHaveCount(5);

  await page.getByTestId("timeline-row").first().click();
  await page.getByTestId("inspector-nav-stream").click();
  await page.getByRole("button", { name: "Load Stream Events" }).click();
  await expect(page.getByTestId("stream-event-card").first()).toBeVisible();

  const deepMetrics = await page.evaluate(() => {
    const aside = document.querySelector("aside");
    if (aside === null) {
      throw new Error("missing inspector");
    }
    aside.scrollTop = aside.scrollHeight;
    return {
      asideScrollTop: aside.scrollTop,
      streamOpen: document.querySelector('[data-testid="inspector-section-stream"]')?.hasAttribute("open"),
      streamCards: document.querySelectorAll('[data-testid="stream-event-card"]').length,
    };
  });

  expect(deepMetrics.asideScrollTop).toBeGreaterThan(0);
  expect(deepMetrics.streamOpen).toBe(true);
  expect(deepMetrics.streamCards).toBeGreaterThan(0);

  await page.getByTestId("timeline-row").first().click();

  await expect.poll(async () => page.evaluate(() => document.querySelector("aside")?.scrollTop ?? -1)).toBe(0);
  await expect(page.getByTestId("stream-event-card")).toHaveCount(0);
  expect(await page.evaluate(() => document.querySelector("main")?.scrollTop ?? -1)).toBe(0);
  expect(await page.evaluate(() => document.querySelector('[data-testid="inspector-section-stream"]')?.hasAttribute("open") ?? null)).toBe(false);
});

test("bounds high-volume stream events and clears them on range changes", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await installHeavyStreamRoutes(page);
  await page.goto("/?since=0");
  await expect(page.getByTestId("timeline-row")).toHaveCount(1);

  await page.getByTestId("inspector-nav-stream").click();
  await page.getByRole("button", { name: "Load Stream Events" }).click();
  await expect(page.getByText("Loaded 100 of 250 stream events")).toBeVisible();
  await expect(page.getByText("Showing 1-25")).toBeVisible();
  await expect(page.getByTestId("stream-event-card")).toHaveCount(25);
  await expect(page.getByTestId("stream-event-payload")).toHaveCount(0);

  await page.getByTestId("stream-event-card").first().getByRole("button", { name: "Show Payload" }).click();
  await expect(page.getByTestId("stream-event-payload")).toHaveCount(1);

  await page.getByRole("button", { name: "Load More Stream Events" }).click();
  await expect(page.getByText("Loaded 200 of 250 stream events")).toBeVisible();
  await expect(page.getByText("Showing 101-125")).toBeVisible();
  await expect(page.getByTestId("stream-event-card")).toHaveCount(25);
  await expect(page.getByTestId("stream-event-payload")).toHaveCount(0);

  await page.getByRole("button", { name: "Load More Stream Events" }).click();
  await expect(page.getByText("Loaded 250 of 250 stream events")).toBeVisible();
  await expect(page.getByText("Showing 201-225")).toBeVisible();
  await expect(page.getByTestId("stream-event-card")).toHaveCount(25);

  const loadedMetrics = await page.evaluate(() => {
    const aside = document.querySelector("aside");
    const stream = document.querySelector('[data-testid="inspector-section-stream"]');
    return {
      cards: document.querySelectorAll('[data-testid="stream-event-card"]').length,
      payloadBlocks: document.querySelectorAll('[data-testid="stream-event-payload"]').length,
      asideScrollHeight: aside?.scrollHeight ?? 0,
      streamHeight: stream?.getBoundingClientRect().height ?? 0,
    };
  });

  expect(loadedMetrics.cards).toBe(25);
  expect(loadedMetrics.payloadBlocks).toBe(0);
  expect(loadedMetrics.asideScrollHeight).toBeLessThan(10_000);
  expect(loadedMetrics.streamHeight).toBeLessThan(5_000);

  await page.getByRole("button", { name: "Today" }).click();
  await expect(page.getByRole("button", { name: "Load Stream Events" })).toBeVisible();
  await expect(page.getByTestId("stream-event-card")).toHaveCount(0);
  await expect.poll(async () => page.evaluate(() => document.querySelector("aside")?.scrollTop ?? -1)).toBe(0);
  expect(await page.evaluate(() => document.querySelector("main")?.scrollTop ?? -1)).toBe(0);
});

test("traps focus in the clear data dialog and closes with Escape", async ({ page }) => {
  await page.goto("/?since=0");
  await expect(page.getByTestId("timeline-row")).toHaveCount(5);

  const trigger = page.getByLabel("Clear spy data");
  await trigger.click();

  const dialog = page.getByRole("dialog", { name: "Clear Spy Data" });
  const cancel = dialog.getByRole("button", { name: "Cancel" });
  const clear = dialog.getByRole("button", { name: "Clear", exact: true });
  await expect(dialog).toBeVisible();
  await expect(cancel).toBeFocused();
  await expect.poll(async () => page.evaluate(() => document.querySelector("main")?.hasAttribute("inert") ?? false)).toBe(true);

  await page.keyboard.press("Tab");
  await expect(clear).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(cancel).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(clear).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  await expect.poll(async () => page.evaluate(() => document.querySelector("main")?.hasAttribute("inert") ?? false)).toBe(false);
});

test("clears data with confirmation", async ({ page }) => {
  await page.goto("/?since=0");
  await expect(page.getByTestId("timeline-row")).toHaveCount(5);
  await page.getByLabel("Clear spy data").click();
  await expect(page.getByRole("dialog", { name: "Clear Spy Data" })).toBeVisible();
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  await expect(page.getByText("No provider calls in this range.")).toBeVisible();
});

async function readRangeState(page: Page): Promise<{
  readonly activeButtons: readonly string[];
  readonly subtitle: string;
}> {
  return page.evaluate(() => {
    const labels = ["Live", "10 min", "1 hour", "Today"];
    const subtitle = document.querySelector("header p");
    if (subtitle === null) {
      throw new Error("missing range subtitle");
    }
    const buttons = Array.from(document.querySelectorAll("button"))
      .filter((button) => labels.includes(button.textContent.trim()));
    return {
      activeButtons: buttons
        .filter((button) => button.className.includes("border-emerald-700"))
        .map((button) => button.textContent.trim()),
      subtitle: subtitle.textContent.trim(),
    };
  });
}

const HEAVY_STREAM_CALL_ID = "call-heavy-stream";
const HEAVY_STREAM_TS = 1779562000;
const HEAVY_STREAM_MODEL_ID = "us.anthropic.claude-sonnet-4-6";
const DIFF_SCOPE_CALL_ID = "call-diff-scope-current";
const DIFF_SCOPE_PREVIOUS_CALL_ID = "call-diff-scope-previous";
const DIFF_SCOPE_TS = 2100;
const DIFF_SCOPE_PREVIOUS_TS = 1900;
const CACHE_TIMELINE_CALL_ID = "call-cache-timeline";
const CACHE_TIMELINE_TS = 1779562500;
const BLOCK_KINDS: readonly NormalizedBlock["kind"][] = [
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

async function installHeavyStreamRoutes(page: Page): Promise<void> {
  const fixture = heavyStreamFixture();
  await page.route(/\/api\/health$/, async (route) => {
    await fulfillJson(route, fixture.health);
  });
  await page.route(/\/api\/calls\/call-heavy-stream\/stream-events(?:\?.*)?$/, async (route) => {
    const url = new URL(route.request().url());
    const limit = Number(url.searchParams.get("limit") ?? "100");
    const cursor = Number(url.searchParams.get("cursor") ?? "0");
    const start = Number.isFinite(cursor) && cursor >= 0 ? cursor : 0;
    const end = Math.min(start + limit, fixture.streamEvents.length);
    const pagePayload: { readonly items: readonly StreamEvent[]; nextCursor?: string | undefined } = {
      items: fixture.streamEvents.slice(start, end),
    };
    if (end < fixture.streamEvents.length) {
      pagePayload.nextCursor = String(end);
    }
    await fulfillJson(route, pagePayload);
  });
  await page.route(/\/api\/calls\/call-heavy-stream\/diff$/, async (route) => {
    await fulfillJson(route, fixture.diff);
  });
  await page.route(/\/api\/calls\/call-heavy-stream$/, async (route) => {
    await fulfillJson(route, fixture.detail);
  });
  await page.route(/\/api\/calls(?:\?.*)?$/, async (route) => {
    await fulfillJson(route, { items: [fixture.summary] });
  });
  await page.route(/\/api\/search(?:\?.*)?$/, async (route) => {
    await fulfillJson(route, { items: [fixture.summary] });
  });
}

async function installDiffScopeRoutes(page: Page): Promise<void> {
  const fixture = diffScopeFixture();
  await page.route(/\/api\/health$/, async (route) => {
    await fulfillJson(route, fixture.health);
  });
  await page.route(/\/api\/calls\/call-diff-scope-current\/diff$/, async (route) => {
    await fulfillJson(route, fixture.diff);
  });
  await page.route(/\/api\/calls\/call-diff-scope-current$/, async (route) => {
    await fulfillJson(route, fixture.detail);
  });
  await page.route(/\/api\/calls(?:\?.*)?$/, async (route) => {
    await fulfillJson(route, { items: [fixture.summary] });
  });
  await page.route(/\/api\/search(?:\?.*)?$/, async (route) => {
    await fulfillJson(route, { items: [fixture.summary] });
  });
}

async function installCacheTimelineRoutes(page: Page): Promise<void> {
  const fixture = cacheTimelineFixture();
  await page.route(/\/api\/health$/, async (route) => {
    await fulfillJson(route, fixture.health);
  });
  await page.route(/\/api\/calls\/call-cache-timeline\/diff$/, async (route) => {
    await fulfillJson(route, fixture.diff);
  });
  await page.route(/\/api\/calls\/call-cache-timeline$/, async (route) => {
    await fulfillJson(route, fixture.detail);
  });
  await page.route(/\/api\/calls(?:\?.*)?$/, async (route) => {
    await fulfillJson(route, { items: [fixture.summary] });
  });
  await page.route(/\/api\/search(?:\?.*)?$/, async (route) => {
    await fulfillJson(route, { items: [fixture.summary] });
  });
}

async function fulfillJson(route: Route, payload: unknown): Promise<void> {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(payload),
  });
}

function diffScopeFixture(): {
  readonly summary: SpyCallSummary;
  readonly detail: SpyCallDetail;
  readonly diff: SpyCallDiff;
  readonly health: SpyServiceHealth;
} {
  const usage = {
    inputTokens: 10,
    outputTokens: 20,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 30,
  };
  const call = {
    id: DIFF_SCOPE_CALL_ID,
    provider: "bedrock" as const,
    operation: "converse-stream",
    model_id: HEAVY_STREAM_MODEL_ID,
    status: "complete" as const,
    started_at: DIFF_SCOPE_TS,
    completed_at: DIFF_SCOPE_TS + 1,
    status_code: 200,
    request_flow_id: "diff-scope-current-flow",
    response_flow_id: "diff-scope-current-flow",
    request_content_hash: "diff-scope-current-request-hash",
    response_content_hash: "diff-scope-current-response-hash",
  };
  const previousCall = {
    ...call,
    id: DIFF_SCOPE_PREVIOUS_CALL_ID,
    started_at: DIFF_SCOPE_PREVIOUS_TS,
    completed_at: DIFF_SCOPE_PREVIOUS_TS + 1,
    request_flow_id: "diff-scope-previous-flow",
    response_flow_id: "diff-scope-previous-flow",
    request_content_hash: "diff-scope-previous-request-hash",
    response_content_hash: "diff-scope-previous-response-hash",
  };
  const summary: SpyCallSummary = {
    call,
    durationMs: 1000,
    usage,
    requestBlockCount: 2,
    responseBlockCount: 1,
    requestByteSize: 256,
    responseByteSize: 128,
    cacheMarkerCount: 0,
    streamEventCount: 0,
    rawPayloadCount: 0,
  };
  const previousSummary: SpyCallSummary = {
    ...summary,
    call: previousCall,
  };
  const blocks = [
    diffScopeBlock("diff-scope-request-envelope", "request", 0, "provider-envelope", "current envelope"),
    diffScopeBlock("diff-scope-request-user", "request", 1, "current-user-input", "current visible request"),
    diffScopeBlock("diff-scope-response", "response", 0, "assistant-output", "current response"),
  ];
  const detail: SpyCallDetail = {
    summary,
    requestComposition: requestComposition(usage),
    httpEvents: [],
    blocks,
    usageRecords: [],
    rawPayloads: [],
  };
  return {
    summary,
    detail,
    diff: {
      call: summary,
      previousCall: previousSummary,
      blocks: blocks
        .filter((block) => block.direction === "request")
        .map((block) => ({ block, classification: "repeated" as const, previousBlockId: `${block.id}-previous` })),
    },
    health: healthFixture(1, DIFF_SCOPE_TS),
  };
}

function cacheTimelineFixture(): {
  readonly summary: SpyCallSummary;
  readonly detail: SpyCallDetail;
  readonly diff: SpyCallDiff;
  readonly health: SpyServiceHealth;
} {
  const usage = {
    inputTokens: 10,
    outputTokens: 98,
    cacheReadTokens: 5200,
    cacheWriteTokens: 81,
    totalTokens: 5389,
  };
  const call = {
    id: CACHE_TIMELINE_CALL_ID,
    provider: "bedrock" as const,
    operation: "converse-stream",
    model_id: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    status: "complete" as const,
    started_at: CACHE_TIMELINE_TS,
    completed_at: CACHE_TIMELINE_TS + 1.4,
    status_code: 200,
    request_flow_id: "cache-timeline-flow",
    response_flow_id: "cache-timeline-flow",
    request_content_hash: "cache-timeline-request-hash",
    response_content_hash: "cache-timeline-response-hash",
  };
  const summary: SpyCallSummary = {
    call,
    durationMs: 1400,
    usage,
    requestBlockCount: 26,
    responseBlockCount: 3,
    requestByteSize: 18_432,
    responseByteSize: 1_229,
    cacheMarkerCount: 2,
    streamEventCount: 0,
    rawPayloadCount: 0,
  };
  const detail: SpyCallDetail = {
    summary,
    requestComposition: {
      ...requestComposition(usage),
      totalBlockCount: 3,
      cacheMarkerCount: 2,
    },
    httpEvents: [],
    blocks: [
      {
        id: "cache-timeline-request",
        call_id: CACHE_TIMELINE_CALL_ID,
        direction: "request",
        ordinal: 0,
        kind: "current-user-input",
        source: "synthetic-cache-timeline",
        provider_path: "$.messages[0]",
        text: "cache-heavy request",
        char_size: 19,
        byte_size: 19,
        content_hash: "cache-timeline-request-block-hash",
        cache_marker: false,
      },
      {
        id: "cache-timeline-marker",
        call_id: CACHE_TIMELINE_CALL_ID,
        direction: "request",
        ordinal: 1,
        kind: "cache-marker",
        source: "synthetic-cache-timeline",
        provider_path: "$.messages[1].cachePoint",
        char_size: 0,
        byte_size: 0,
        content_hash: "cache-timeline-marker-hash",
        cache_marker: true,
      },
      {
        id: "cache-timeline-response",
        call_id: CACHE_TIMELINE_CALL_ID,
        direction: "response",
        ordinal: 0,
        kind: "assistant-output",
        source: "synthetic-cache-timeline",
        provider_path: "$.output.message.content[0].text",
        text: "done",
        char_size: 4,
        byte_size: 4,
        content_hash: "cache-timeline-response-block-hash",
        cache_marker: false,
      },
    ],
    usageRecords: [
      {
        id: "usage-cache-timeline",
        call_id: CACHE_TIMELINE_CALL_ID,
        source: "provider-reported",
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
        cache_read_tokens: usage.cacheReadTokens,
        cache_write_tokens: usage.cacheWriteTokens,
        total_tokens: usage.totalTokens,
        raw: {},
      },
    ],
    rawPayloads: [],
  };
  return {
    summary,
    detail,
    diff: {
      call: summary,
      previousCall: null,
      blocks: detail.blocks.map((block) => ({ block, classification: "new" as const })),
    },
    health: healthFixture(1, CACHE_TIMELINE_TS),
  };
}

function heavyStreamFixture(): {
  readonly summary: SpyCallSummary;
  readonly detail: SpyCallDetail;
  readonly diff: SpyCallDiff;
  readonly health: SpyServiceHealth;
  readonly streamEvents: readonly StreamEvent[];
} {
  const usage = {
    inputTokens: 10,
    outputTokens: 100,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 110,
  };
  const call = {
    id: HEAVY_STREAM_CALL_ID,
    provider: "bedrock" as const,
    operation: "converse-stream",
    model_id: HEAVY_STREAM_MODEL_ID,
    status: "complete" as const,
    started_at: HEAVY_STREAM_TS,
    completed_at: HEAVY_STREAM_TS + 2,
    status_code: 200,
    request_flow_id: "heavy-stream-flow",
    response_flow_id: "heavy-stream-flow",
    request_content_hash: "heavy-request-hash",
    response_content_hash: "heavy-response-hash",
  };
  const summary: SpyCallSummary = {
    call,
    durationMs: 2000,
    usage,
    requestBlockCount: 2,
    responseBlockCount: 1,
    requestByteSize: 2048,
    responseByteSize: 1024,
    cacheMarkerCount: 0,
    streamEventCount: 250,
    rawPayloadCount: 0,
  };
  const blocks = [
    normalizedBlock("block-request-envelope", "request", 0, "provider-envelope", "synthetic envelope"),
    normalizedBlock("block-request-user", "request", 1, "current-user-input", "show a long stream"),
    normalizedBlock("block-response", "response", 0, "assistant-output", "done"),
  ];
  const detail: SpyCallDetail = {
    summary,
    requestComposition: requestComposition(usage),
    httpEvents: [
      {
        id: "http-request-heavy-stream",
        call_id: HEAVY_STREAM_CALL_ID,
        direction: "request",
        observed_at: HEAVY_STREAM_TS,
        host: "bedrock-runtime.us-east-1.amazonaws.com",
        method: "POST",
        path: `/model/${HEAVY_STREAM_MODEL_ID}/converse-stream`,
        headers: [["content-type", "application/json"]],
      },
      {
        id: "http-response-heavy-stream",
        call_id: HEAVY_STREAM_CALL_ID,
        direction: "response",
        observed_at: HEAVY_STREAM_TS + 2,
        host: "bedrock-runtime.us-east-1.amazonaws.com",
        method: "POST",
        path: `/model/${HEAVY_STREAM_MODEL_ID}/converse-stream`,
        status_code: 200,
        reason: "OK",
        headers: [["content-type", "application/vnd.amazon.eventstream"]],
        request_headers: [["authorization", "[redacted]"]],
      },
    ],
    blocks,
    usageRecords: [
      {
        id: "usage-heavy-stream",
        call_id: HEAVY_STREAM_CALL_ID,
        source: "provider-reported",
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
        cache_read_tokens: usage.cacheReadTokens,
        cache_write_tokens: usage.cacheWriteTokens,
        total_tokens: usage.totalTokens,
        raw: {},
      },
    ],
    rawPayloads: [],
  };
  return {
    summary,
    detail,
    diff: {
      call: summary,
      previousCall: null,
      blocks: blocks.map((block) => ({ block, classification: "new" as const })),
    },
    health: {
      ...healthFixture(1, HEAVY_STREAM_TS),
    },
    streamEvents: Array.from({ length: 250 }, (_, index) => streamEvent(index)),
  };
}

function healthFixture(providerCallCount: number, lastIngestAt: number): SpyServiceHealth {
  return {
    ok: true,
    service: {
      enabled: true,
      bind: "127.0.0.1",
      port: 4674,
      retentionDays: 7,
      maxBytes: 6442450944,
      spoolMaxBytes: 1073741824,
      storeRaw: false,
      staticAssets: true,
    },
    store: {
      schemaVersion: 2,
      dbSizeBytes: 123456,
      dbUsedBytes: 123456,
      spoolSizeBytes: 0,
      providerCallCount,
      pendingCallCount: 0,
      droppedCaptureCount: 0,
      lastIngestAt,
      counters: {},
      metadata: {},
    },
  };
}

function requestComposition(usage: SpyCallSummary["usage"]): SpyRequestComposition {
  return {
    totalBlockCount: 2,
    totalMessageCount: 1,
    totalCharSize: 128,
    totalByteSize: 128,
    sections: BLOCK_KINDS.map((kind, index) => ({
      kind,
      present: index < 2,
      blockCount: index < 2 ? 1 : 0,
      messageCount: kind === "current-user-input" ? 1 : 0,
      charSize: index < 2 ? 64 : 0,
      byteSize: index < 2 ? 64 : 0,
    })),
    toolDefinitionCount: 0,
    toolSchemaCharSize: 0,
    toolSchemaByteSize: 0,
    cacheMarkerCount: 0,
    cacheMarkerCharSize: 0,
    cacheMarkerByteSize: 0,
    mediaSummaryCount: 0,
    mediaSummaryCharSize: 0,
    mediaSummaryByteSize: 0,
    usage,
  };
}

function normalizedBlock(
  id: string,
  direction: NormalizedBlock["direction"],
  ordinal: number,
  kind: NormalizedBlock["kind"],
  text: string,
): NormalizedBlock {
  return {
    id,
    call_id: HEAVY_STREAM_CALL_ID,
    direction,
    ordinal,
    kind,
    source: "synthetic-stream-rca",
    provider_path: "$.synthetic",
    text,
    char_size: text.length,
    byte_size: new TextEncoder().encode(text).length,
    content_hash: `${id}-hash`,
    cache_marker: false,
  };
}

function diffScopeBlock(
  id: string,
  direction: NormalizedBlock["direction"],
  ordinal: number,
  kind: NormalizedBlock["kind"],
  text: string,
): NormalizedBlock {
  return {
    id,
    call_id: DIFF_SCOPE_CALL_ID,
    direction,
    ordinal,
    kind,
    source: "synthetic-diff-scope",
    provider_path: "$.synthetic",
    text,
    char_size: text.length,
    byte_size: new TextEncoder().encode(text).length,
    content_hash: `${id}-hash`,
    cache_marker: false,
  };
}

function streamEvent(index: number): StreamEvent {
  return {
    id: `stream-${String(index).padStart(3, "0")}`,
    call_id: HEAVY_STREAM_CALL_ID,
    ordinal: index,
    event_type: "contentBlockDelta",
    headers: {
      ":event-type": "contentBlockDelta",
      ":content-type": "application/json",
    },
    payload: {
      contentBlockIndex: 0,
      delta: {
        text: `chunk ${String(index)}`,
      },
      p: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".repeat(5),
      metadata: {
        synthetic: true,
        index,
      },
    },
    payload_sha256: `sha-${String(index)}`,
    observed_at: HEAVY_STREAM_TS + 2,
  };
}
