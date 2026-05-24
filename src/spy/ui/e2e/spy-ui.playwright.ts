import { expect, type Locator, type Page, type Route, test } from "@playwright/test";
import type {
  NormalizedBlock,
  RawPayloadRecord,
  SpyCallDetail,
  SpyCallDiff,
  SpyCallSummary,
  SpyCompactionAssessment,
  SpyRequestComposition,
  SpyServiceHealth,
  SpyTokenCountRecord,
  StreamEvent,
} from "../src/types.ts";

test.describe.configure({ mode: "serial" });

test("loads fixture calls and receives live updates", async ({ page }) => {
  await page.goto("/?since=0");
  await expect(page.getByRole("heading", { name: "Rootcell Spy" })).toBeVisible();
  await expect(page.getByTestId("timeline-row")).toHaveCount(4);
  await expect(page.getByTestId("timeline-row")).toHaveCount(5);
});

test("uses singular grammar for one visible timeline call", async ({ page }) => {
  await page.goto("/?since=0");
  await expect(timelineRow(page, "call-fixture-flow-simple")).toBeVisible();

  await page.getByLabel("Search text, call ID, or model").fill("call-fixture-flow-simple");
  await page.getByRole("button", { name: "Search" }).click();

  await expect(page.getByTestId("timeline-row")).toHaveCount(1);
  await expect(page.getByTestId("timeline-footer")).toHaveText(/^\s*1 call\s*Load More\s*$/);
  await expect(page.getByText("1 calls", { exact: true })).toHaveCount(0);
});

test("labels disconnected SSE as passive status text", async ({ page }) => {
  await page.route(/\/api\/events$/, async (route) => {
    await route.abort();
  });

  await page.goto("/?since=0");
  await expect(page.getByRole("heading", { name: "Rootcell Spy" })).toBeVisible();
  await expect(page.getByRole("status", { name: "SSE offline" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Reconnect", exact: true })).toHaveCount(0);
  await expect(page.getByText("Reconnect", { exact: true })).toHaveCount(0);
});

test("keeps timeline range state synchronized with the URL", async ({ page }) => {
  await page.goto("/?since=0");
  await expect(page.getByTestId("timeline-row")).toHaveCount(5);

  const initialState = await readRangeState(page);
  expect(initialState.subtitle).toContain("Since ");
  expect(initialState.activeButtons).toEqual(["Custom"]);

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

test("keeps custom range state explicit and preserves precise since values", async ({ page }) => {
  await page.setViewportSize({ width: 1159, height: 862 });
  await page.goto("/?preset=custom&since=1779562507");
  await expect(page.getByRole("heading", { name: "Rootcell Spy" })).toBeVisible();

  const initialState = await readRangeState(page);
  expect(initialState.subtitle).toMatch(/:07(?:\s|$)/);
  expect(initialState.activeButtons).toEqual(["Custom"]);
  await expect(page.getByRole("button", { name: "Custom" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Live" })).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByRole("button", { name: "Apply" })).not.toHaveClass(/bg-emerald-700/);
  await expect(page.getByRole("button", { name: "Apply" })).not.toHaveAttribute("aria-pressed", "true");

  const customInput = page.getByLabel("Custom start time");
  const customInputMetrics = await customInput.evaluate((input) => {
    if (!(input instanceof HTMLInputElement)) {
      throw new Error("custom start time control is not an input");
    }
    const styles = getComputedStyle(input);
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (context === null) {
      throw new Error("missing canvas context");
    }
    context.font = styles.font;
    const usableWidth = input.clientWidth - parseFloat(styles.paddingLeft) - parseFloat(styles.paddingRight);
    const pmDisplayWidth = context.measureText("05/23/2026, 02:55 PM").width;
    return {
      usableWidth,
      pmDisplayWidth,
      slack: usableWidth - pmDisplayWidth,
    };
  });
  expect(customInputMetrics.usableWidth).toBeGreaterThan(200);
  expect(customInputMetrics.slack).toBeGreaterThanOrEqual(32);

  const originalDraft = await customInput.inputValue();
  expect(originalDraft).not.toContain(":07");

  await page.getByRole("button", { name: "Apply" }).click();
  expect(new URL(page.url()).searchParams.get("since")).toBe("1779562507");
  expect((await readRangeState(page)).activeButtons).toEqual(["Custom"]);

  const changedDraft = await page.evaluate((draft) => {
    const parsed = new Date(draft);
    parsed.setMinutes(parsed.getMinutes() + 1);
    const offsetMs = parsed.getTimezoneOffset() * 60 * 1000;
    return new Date(parsed.getTime() - offsetMs).toISOString().slice(0, 16);
  }, originalDraft);
  await customInput.fill(changedDraft);
  await page.getByRole("button", { name: "Apply" }).click();

  const expectedChangedSince = await page.evaluate((draft) => Math.floor(new Date(draft).getTime() / 1000), changedDraft);
  const changedSince = Number(new URL(page.url()).searchParams.get("since"));
  expect(changedSince).toBe(expectedChangedSince);
  expect(changedSince % 60).toBe(0);
});

test("exposes ARIA state for selected timeline row and active range", async ({ page }) => {
  await page.goto("/?since=0");
  await expect(page.getByTestId("timeline-row")).toHaveCount(5);

  const selectedRow = timelineRow(page, "call-fixture-flow-tool-result");
  const otherRow = timelineRow(page, "call-fixture-flow-tool-use");

  await expect(page.getByRole("button", { name: "Custom" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Live" })).toHaveAttribute("aria-pressed", "false");
  await expect(selectedRow).toHaveAccessibleName(/model claude-sonnet-4-6, status complete, started .+, operation converse-stream, read 1,253, write 8, input/);
  await expect(selectedRow).not.toHaveAccessibleName(/cache read/);
  await expect(selectedRow.getByTestId("timeline-usage-metrics")).toHaveAttribute("aria-label", "read 1,253, write 8");
  await expect(selectedRow.locator("[data-usage-metric]")).toHaveCount(2);
  await selectedRow.click();
  await expect(selectedRow).toHaveAttribute("aria-current", "true");
  expect(await otherRow.getAttribute("aria-current")).toBeNull();

  await otherRow.click();

  await expect(otherRow).toHaveAttribute("aria-current", "true");
  expect(await selectedRow.getAttribute("aria-current")).toBeNull();
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

test("preserves inspector scroll during rolling range refreshes", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/?since=0");
  await expect(page.getByTestId("timeline-row")).toHaveCount(5);

  await page.getByRole("button", { name: "10 min" }).click();
  await expect(page.getByTestId("timeline-row")).toHaveCount(5);
  await page.getByTestId("timeline-row").first().click();
  await expect(page.getByTestId("request-composition")).toBeVisible();

  const beforeRefresh = await page.evaluate(async () => {
    const body = document.querySelector('[data-testid="inspector-scroll-body"]');
    if (body === null) {
      throw new Error("missing inspector body");
    }
    body.scrollTop = body.scrollHeight;
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        resolve();
      });
    });
    return body.scrollTop;
  });
  expect(beforeRefresh).toBeGreaterThan(0);

  const initialSubtitle = (await readRangeState(page)).subtitle;
  await page.waitForTimeout(2100);
  const refreshResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/calls");
  await page.getByLabel("Refresh calls").click();
  await refreshResponse;

  const afterRefresh = await page.evaluate(async () => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          resolve();
        });
      });
    });
    return document.querySelector('[data-testid="inspector-scroll-body"]')?.scrollTop ?? -1;
  });
  expect(afterRefresh).toBeGreaterThan(0);
  expect((await readRangeState(page)).subtitle).not.toBe(initialSubtitle);

  const url = new URL(page.url());
  expect(url.searchParams.get("preset")).toBe("10m");
  expect(url.searchParams.has("since")).toBe(false);
});

test("keeps timeline and inspector scroll containers inside the viewport", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/?since=0");
  await expect(page.getByTestId("timeline-row")).toHaveCount(5);
  await expect(page.getByTestId("request-composition")).toBeVisible();

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
    const inspectorBody = document.querySelector('[data-testid="inspector-scroll-body"]');
    if (main === null || timeline === null || aside === null || inspectorBody === null) {
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
      inspectorBodyClientHeight: inspectorBody.clientHeight,
      inspectorBodyScrollHeight: inspectorBody.scrollHeight,
    };
  });

  expect(initialMetrics.mainScrollHeight).toBe(initialMetrics.mainClientHeight);
  expect(initialMetrics.timelineBottom).toBeLessThanOrEqual(initialMetrics.viewportHeight);
  expect(initialMetrics.asideBottom).toBeLessThanOrEqual(initialMetrics.viewportHeight);
  expect(initialMetrics.timelineScrollHeight).toBeGreaterThan(initialMetrics.timelineClientHeight);
  expect(initialMetrics.inspectorBodyScrollHeight).toBeGreaterThan(initialMetrics.inspectorBodyClientHeight);

  const tailMetrics = await page.evaluate(() => {
    const inspectorBody = document.querySelector('[data-testid="inspector-scroll-body"]');
    if (inspectorBody === null) {
      throw new Error("missing inspector body");
    }
    inspectorBody.scrollTop = inspectorBody.scrollHeight;
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
      inspectorScrollTop: inspectorBody.scrollTop,
      inspectorMaxScrollTop: inspectorBody.scrollHeight - inspectorBody.clientHeight,
    };
  });

  expect(tailMetrics.inspectorScrollTop).toBe(tailMetrics.inspectorMaxScrollTop);
  expect(tailMetrics.healthTop).toBeGreaterThanOrEqual(0);
  expect(tailMetrics.healthBottom).toBeLessThanOrEqual(tailMetrics.viewportHeight);
});

test("keeps scrolled inspector content below the inspector header", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/?since=0");
  await expect(page.getByTestId("timeline-row")).toHaveCount(5);
  await page.getByTestId("timeline-row").first().click();

  const metrics = await page.evaluate(async () => {
    const header = document.querySelector('[data-testid="inspector-header"]');
    const body = document.querySelector('[data-testid="inspector-scroll-body"]');
    const composition = document.querySelector('[data-testid="inspector-section-composition"]');
    if (header === null || body === null || composition === null) {
      throw new Error("missing inspector layout elements");
    }
    body.scrollTop = 360;
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        resolve();
      });
    });

    const headerRect = header.getBoundingClientRect();
    const bodyRect = body.getBoundingClientRect();
    const compositionRect = composition.getBoundingClientRect();
    const x = bodyRect.left + Math.min(40, bodyRect.width / 2);
    const headerPointY = headerRect.bottom - 4;
    const contentUnderHeader = document.elementsFromPoint(x, headerPointY).some((element) => {
      if (header.contains(element)) {
        return false;
      }
      return element.closest('[data-testid="request-composition"], [data-testid^="inspector-section-"]') !== null;
    });

    return {
      bodyTop: Math.round(bodyRect.top),
      compositionTop: Math.round(compositionRect.top),
      contentUnderHeader,
      headerBottom: Math.round(headerRect.bottom),
      inspectorBodyScrollTop: body.scrollTop,
    };
  });

  expect(metrics.inspectorBodyScrollTop).toBeGreaterThan(0);
  expect(metrics.bodyTop).toBeGreaterThanOrEqual(metrics.headerBottom);
  expect(metrics.contentUnderHeader).toBe(false);
  expect(metrics.compositionTop).toBeLessThan(metrics.bodyTop);
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

test("shows full provider model id in the selected-call summary", async ({ page }) => {
  const fullModelId = "us.anthropic.claude-sonnet-4-6";
  const shortModelId = "claude-sonnet-4-6";

  await page.goto("/?since=0");
  await expect(page.getByTestId("timeline-row")).toHaveCount(5);

  const firstRow = page.getByTestId("timeline-row").first();
  await expect(firstRow.getByText(shortModelId, { exact: true })).toBeVisible();
  await expect(firstRow).not.toContainText(fullModelId);
  await firstRow.click();

  const summary = page.getByTestId("inspector-section-summary");
  await expect(summary.getByText("Model ID", { exact: true })).toBeVisible();
  await expect(summary.getByTestId("summary-model-id")).toContainText(fullModelId);
});

test("shows compaction candidate labels in the selected-call summary", async ({ page }) => {
  await installCompactionRoutes(page);
  await page.goto("/?since=0");
  await timelineRow(page, DIFF_SCOPE_CALL_ID).click();

  const candidate = page.getByTestId("compaction-candidate");
  await expect(candidate).toBeVisible();
  await expect(candidate).toContainText("Pi compaction candidate");
  await expect(candidate).toContainText("high confidence");
  await expect(candidate).toContainText("summary-like history");
});

test("keeps inspector summary metric values readable", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/?since=0");
  await expect(page.getByTestId("timeline-row")).toHaveCount(5);
  await page.getByTestId("timeline-row").first().click();

  const started = page.getByTestId("inspector-section-summary").locator('[data-summary-metric="Started"]');
  await expect(started).toContainText("May");

  const metrics = await started.evaluate((element) => {
    const styles = getComputedStyle(element);
    return {
      clientWidth: element.clientWidth,
      overflow: styles.overflow,
      scrollWidth: element.scrollWidth,
      textOverflow: styles.textOverflow,
      value: element.textContent.trim(),
      whiteSpace: styles.whiteSpace,
    };
  });

  expect(metrics.value).toContain(":");
  expect(metrics.scrollWidth, "Started summary value should not clip").toBeLessThanOrEqual(metrics.clientWidth);
  expect(metrics.overflow).not.toBe("hidden");
  expect(metrics.textOverflow).not.toBe("ellipsis");
  expect(metrics.whiteSpace).not.toBe("nowrap");
});

test("shows pinned inspector state when a newer visible call is available", async ({ page }) => {
  await page.goto("/?since=0");
  await expect(page.getByTestId("timeline-row")).toHaveCount(5);
  await expect(page.getByTestId("inspector-pinned-state")).toHaveCount(0);

  await timelineRow(page, "call-fixture-flow-tool-use").click();
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
    const inspectorBody = document.querySelector('[data-testid="inspector-scroll-body"]');
    const requestBlocks = document.querySelector('[data-testid="inspector-section-request-blocks"]');
    const responseBlocks = document.querySelector('[data-testid="inspector-section-response-blocks"]');
    const health = document.querySelector('[data-testid="inspector-section-health"]');
    if (inspectorBody === null || requestBlocks === null || responseBlocks === null || health === null) {
      throw new Error("missing inspector section");
    }
    return {
      viewportHeight: window.innerHeight,
      requestBlocksOpen: requestBlocks.hasAttribute("open"),
      responseBlocksOpen: responseBlocks.hasAttribute("open"),
      healthTop: health.getBoundingClientRect().top,
      inspectorScrollTop: inspectorBody.scrollTop,
      mainScrollTop: document.querySelector("main")?.scrollTop,
    };
  });

  expect(initialMetrics.requestBlocksOpen).toBe(false);
  expect(initialMetrics.responseBlocksOpen).toBe(false);
  expect(initialMetrics.healthTop).toBeGreaterThan(initialMetrics.viewportHeight);
  expect(initialMetrics.inspectorScrollTop).toBe(0);
  expect(initialMetrics.mainScrollTop).toBe(0);

  await page.getByTestId("inspector-nav-health").click();

  const jumpedMetrics = await page.evaluate(() => {
    const inspectorBody = document.querySelector('[data-testid="inspector-scroll-body"]');
    const main = document.querySelector("main");
    const header = document.querySelector("header");
    const inspectorHeader = document.querySelector('[data-testid="inspector-header"]');
    const health = document.querySelector('[data-testid="inspector-section-health"]');
    if (inspectorBody === null || main === null || header === null || inspectorHeader === null || health === null) {
      throw new Error("missing layout element");
    }
    const healthRect = health.getBoundingClientRect();
    const headerRect = header.getBoundingClientRect();
    const inspectorHeaderRect = inspectorHeader.getBoundingClientRect();
    return {
      viewportHeight: window.innerHeight,
      inspectorScrollTop: inspectorBody.scrollTop,
      mainScrollTop: main.scrollTop,
      headerTop: headerRect.top,
      headerBottom: headerRect.bottom,
      inspectorHeaderBottom: inspectorHeaderRect.bottom,
      healthTop: healthRect.top,
      healthBottom: healthRect.bottom,
    };
  });

  expect(jumpedMetrics.inspectorScrollTop).toBeGreaterThan(0);
  expect(jumpedMetrics.mainScrollTop).toBe(0);
  expect(jumpedMetrics.headerTop).toBe(0);
  expect(jumpedMetrics.headerBottom).toBeGreaterThan(0);
  expect(jumpedMetrics.healthTop).toBeGreaterThanOrEqual(jumpedMetrics.inspectorHeaderBottom);
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
  await expect(timelineRow(page, "call-fixture-flow-tool-result")).toBeVisible();
  await page.getByLabel("Search text, call ID, or model").fill("sonnet");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.getByTestId("timeline-row")).toHaveCount(5);
});

test("labels diff baselines outside the current range", async ({ page }) => {
  await installDiffScopeRoutes(page);
  await page.goto("/?preset=custom&since=2000");

  await expect(page.getByTestId("timeline-row")).toHaveCount(1);
  await expect(timelineRow(page, "call-diff-scope-current")).toBeVisible();
  await page.getByTestId("inspector-nav-diff").click();

  const diffSection = page.getByTestId("inspector-section-diff");
  await expect(diffSection).toBeVisible();
  await expect(diffSection.getByText("Previous comparable request:", { exact: false })).toBeVisible();
  await expect(diffSection.getByText("call-diff-scope-previous", { exact: false })).toBeVisible();
  await expect(diffSection.getByText("outside current range", { exact: true })).toBeVisible();
  await expect(diffSection.getByText("Diff baseline is global across stored comparable calls, not scoped to the visible timeline.", { exact: true })).toBeVisible();
});

test("shows provider cache token classes in timeline rows", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 850 });
  await installCacheTimelineRoutes(page);
  await page.goto("/?since=0");

  const row = timelineRow(page, CACHE_TIMELINE_CALL_ID);
  await expect(row).toBeVisible();
  await expect(row).toHaveAccessibleName(/model claude-haiku-4-5-20251001-v1:0, status complete, started .+, operation converse-stream, read 10, write 98, cache read 5,200, cache write 81/);
  const usageMetrics = row.getByTestId("timeline-usage-metrics");
  await expect(usageMetrics).toHaveAttribute("aria-label", "read 10, write 98, cache read 5,200, cache write 81");
  await expect(usageMetrics).toHaveText("1098R5,200W81");
  const read = row.locator('[data-usage-metric="read"]');
  const write = row.locator('[data-usage-metric="write"]');
  const cacheRead = row.locator('[data-usage-metric="cache read"]');
  const cacheWrite = row.locator('[data-usage-metric="cache write"]');
  await expect(read).toHaveAttribute("aria-label", "read 10");
  await expect(read).toContainText("10");
  await expect(write).toHaveAttribute("aria-label", "write 98");
  await expect(write).toContainText("98");
  await expect(cacheRead).toHaveAttribute("aria-label", "cache read 5,200");
  await expect(cacheRead).toHaveText("R5,200");
  await expect(cacheWrite).toHaveAttribute("aria-label", "cache write 81");
  await expect(cacheWrite).toHaveText("W81");
  const metrics = await row.locator("[data-usage-metric]").evaluateAll((elements) =>
    elements.map((element) => ({
      label: element.getAttribute("data-usage-metric"),
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      text: element.textContent,
    })),
  );
  expect(metrics).toHaveLength(4);
  for (const metric of metrics) {
    expect(metric.scrollWidth, `${metric.label ?? "metric"} should not clip ${metric.text}`).toBeLessThanOrEqual(metric.clientWidth);
  }
  const usageLayout = await usageMetrics.evaluate((element) => {
    const row = element.closest('[data-testid="timeline-row"]');
    if (!(row instanceof HTMLElement)) {
      throw new Error("missing row");
    }
    return {
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      rowClientWidth: row.clientWidth,
    };
  });
  expect(usageLayout.scrollWidth).toBeLessThanOrEqual(usageLayout.clientWidth);
  expect(usageLayout.clientWidth).toBeLessThan(usageLayout.rowClientWidth / 2);
  await expect(row).not.toContainText("usage");
  await expect(row).not.toContainText("tok");
  await expect(row).not.toContainText("cache 2");
});

test("scopes block-kind filtering across request and response blocks", async ({ page }) => {
  await installBlockFilterRoutes(page);
  await page.goto("/?since=0");

  const toolbar = page.getByTestId("block-filter-toolbar");
  const filter = toolbar.getByLabel("Filter request and response blocks by kind");
  const requestSection = page.getByTestId("inspector-section-request-blocks");
  const responseSection = page.getByTestId("inspector-section-response-blocks");

  await expect(toolbar).toBeVisible();
  await expect(toolbar.getByText("Request and response blocks", { exact: true })).toBeVisible();
  await expect(requestSection.getByLabel("Filter request and response blocks by kind")).toHaveCount(0);
  await expect(requestSection.getByText("Only appears in request A", { exact: true })).toBeVisible();
  await expect(responseSection.getByText("Only appears in response A", { exact: true })).toBeVisible();

  await filter.selectOption("current-user-input");
  await expect(requestSection.getByText("Only appears in request A", { exact: true })).toBeVisible();
  await expect(responseSection.getByText("No Current User Input blocks in this section.", { exact: true })).toBeVisible();
  await expect(responseSection.getByText("Only appears in response A", { exact: true })).toHaveCount(0);

  await timelineRow(page, BLOCK_FILTER_CALL_B_ID).click();
  await expect(page.locator("aside").getByText(BLOCK_FILTER_CALL_B_ID, { exact: true })).toBeVisible();
  await expect(filter).toHaveValue("current-user-input");
  await expect(requestSection.getByText("Only appears in request B", { exact: true })).toBeVisible();
  await expect(responseSection.getByText("No Current User Input blocks in this section.", { exact: true })).toBeVisible();
  await expect(responseSection.getByText("Only appears in response B", { exact: true })).toHaveCount(0);
});

test("keeps request composition readable at normal browser width", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 850 });
  await installCacheTimelineRoutes(page);
  await page.goto("/?since=0");

  const composition = page.getByTestId("request-composition");
  await expect(composition).toBeVisible();
  await expect(composition.getByTestId("composition-provider-usage-detail")).toHaveText("in 10 · out 98 · cache 5,200/81");

  const metrics = await composition.evaluate((element) => {
    const usageDetail = element.querySelector('[data-testid="composition-provider-usage-detail"]');
    const sectionTable = element.querySelector('[data-testid="composition-section-table"]');
    if (!(usageDetail instanceof HTMLElement) || !(sectionTable instanceof HTMLElement)) {
      throw new Error("missing composition responsive elements");
    }
    return {
      usageDetailClientWidth: usageDetail.clientWidth,
      usageDetailScrollWidth: usageDetail.scrollWidth,
      sectionTableClientWidth: sectionTable.clientWidth,
      sectionTableScrollWidth: sectionTable.scrollWidth,
      sectionTableOverflowX: getComputedStyle(sectionTable).overflowX,
    };
  });

  expect(metrics.usageDetailScrollWidth).toBeLessThanOrEqual(metrics.usageDetailClientWidth);
  expect(metrics.sectionTableScrollWidth).toBeLessThanOrEqual(metrics.sectionTableClientWidth);
  expect(metrics.sectionTableOverflowX).not.toBe("hidden");
});

test("keeps network metadata request targets readable", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 850 });
  await installNetworkMetadataRoutes(page);
  await page.goto("/?since=0");

  const network = page.getByTestId("inspector-section-network");
  await expect(network).toBeVisible();
  await page.getByTestId("inspector-nav-network").click();

  const displayPath = network.getByTestId("network-display-path").first();
  await expect(displayPath).toContainText("us.anthropic.claude-haiku-4-5-20251001-v1:0");
  await expect(displayPath).not.toContainText("%3A0");
  await expect(network.getByTestId("network-display-query").first()).toContainText("X-Amz-Credential=[redacted]");

  const metrics = await displayPath.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
    overflow: getComputedStyle(element).overflow,
    textOverflow: getComputedStyle(element).textOverflow,
    whiteSpace: getComputedStyle(element).whiteSpace,
  }));
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth);
  expect(metrics.overflow).not.toBe("hidden");
  expect(metrics.textOverflow).not.toBe("ellipsis");
  expect(metrics.whiteSpace).not.toBe("nowrap");

  await network.getByText("Raw target", { exact: true }).first().click();
  await expect(network.getByTestId("network-raw-target").first()).toContainText("v1%3A0");
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
    const inspectorBody = document.querySelector('[data-testid="inspector-scroll-body"]');
    if (inspectorBody === null) {
      throw new Error("missing inspector body");
    }
    inspectorBody.scrollTop = inspectorBody.scrollHeight;
    return {
      inspectorScrollTop: inspectorBody.scrollTop,
      streamOpen: document.querySelector('[data-testid="inspector-section-stream"]')?.hasAttribute("open"),
      streamCards: document.querySelectorAll('[data-testid="stream-event-card"]').length,
    };
  });

  expect(deepMetrics.inspectorScrollTop).toBeGreaterThan(0);
  expect(deepMetrics.streamOpen).toBe(true);
  expect(deepMetrics.streamCards).toBeGreaterThan(0);

  await page.getByTestId("timeline-row").first().click();

  await expect.poll(async () => page.evaluate(() => document.querySelector('[data-testid="inspector-scroll-body"]')?.scrollTop ?? -1)).toBe(0);
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
    const inspectorBody = document.querySelector('[data-testid="inspector-scroll-body"]');
    const stream = document.querySelector('[data-testid="inspector-section-stream"]');
    return {
      cards: document.querySelectorAll('[data-testid="stream-event-card"]').length,
      payloadBlocks: document.querySelectorAll('[data-testid="stream-event-payload"]').length,
      inspectorBodyScrollHeight: inspectorBody?.scrollHeight ?? 0,
      streamHeight: stream?.getBoundingClientRect().height ?? 0,
    };
  });

  expect(loadedMetrics.cards).toBe(25);
  expect(loadedMetrics.payloadBlocks).toBe(0);
  expect(loadedMetrics.inspectorBodyScrollHeight).toBeLessThan(10_000);
  expect(loadedMetrics.streamHeight).toBeLessThan(5_000);

  await page.getByRole("button", { name: "Today" }).click();
  await expect(page.getByRole("button", { name: "Load Stream Events" })).toBeVisible();
  await expect(page.getByTestId("stream-event-card")).toHaveCount(0);
  await expect.poll(async () => page.evaluate(() => document.querySelector('[data-testid="inspector-scroll-body"]')?.scrollTop ?? -1)).toBe(0);
  expect(await page.evaluate(() => document.querySelector("main")?.scrollTop ?? -1)).toBe(0);
});

test("shows backend token provenance and counts selected block text", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await installHeavyStreamRoutes(page);
  await page.goto("/?since=0");
  await page.getByTestId("timeline-row").click();

  const block = page.getByTestId("block-row-block-request-user");
  await expect(block.getByText("5 tok", { exact: true })).toBeVisible();
  await expect(block.getByTestId("provider-count-block-request-user")).toHaveCount(0);

  await block.locator("pre").evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  await block.getByTestId("selection-count-block-request-user").click();
  await expect(block.getByTestId("selection-token-count")).toContainText("5 tok");
  await expect(block.getByTestId("selection-token-count")).toContainText("provider counted");
});

test("virtualizes large block lists while preserving large block text selection", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const fixture = largeContentFixture();
  const expectedSelection = fixture.largeText.slice(0, Math.floor(fixture.largeText.length / 2));
  const tokenCapture = { count: 0, sawExpectedSelection: false, lastLength: 0 };
  await installLargeContentRoutes(page, { expectedSelection, tokenCapture });

  await page.goto("/?since=0");
  await expect(page.getByTestId("timeline-row")).toHaveCount(1);
  await page.getByTestId("inspector-nav-request-blocks").click();

  const virtualList = page.getByTestId("virtual-block-list").first();
  await expect(virtualList).toBeVisible();
  await expect(page.getByTestId("block-row-large-request-000")).toBeVisible();

  const initialMetrics = await page.evaluate(() => ({
    mountedRows: document.querySelectorAll('[data-testid^="block-row-"]').length,
    fullTextControls: document.querySelectorAll('textarea[data-testid="block-body-full"]').length,
  }));
  expect(initialMetrics.mountedRows).toBeLessThan(40);
  expect(initialMetrics.fullTextControls).toBe(0);

  const largeBlock = page.getByTestId("block-row-large-request-000");
  await expect(largeBlock.getByText("Preview", { exact: true })).toBeVisible();
  await largeBlock.getByRole("button", { name: "Show Full Text" }).click();
  const fullText = largeBlock.getByTestId("block-body-full");
  await expect(fullText).toBeVisible();

  const selectionLength = expectedSelection.length;
  await fullText.evaluate((element, end) => {
    if (!(element instanceof HTMLTextAreaElement)) {
      throw new Error("large block full text is not a textarea");
    }
    element.focus();
    element.setSelectionRange(0, end);
  }, selectionLength);

  await largeBlock.getByTestId("selection-count-large-request-000").click();
  await expect(largeBlock.getByTestId("selection-token-count")).toContainText("12,345 tok");
  expect(tokenCapture.count).toBe(1);
  expect(tokenCapture.lastLength).toBe(expectedSelection.length);
  expect(tokenCapture.sawExpectedSelection).toBe(true);
});

test("keeps large raw and stream payloads collapsed and bounded", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await installLargeContentRoutes(page);

  await page.goto("/?since=0");
  await expect(page.getByTestId("timeline-row")).toHaveCount(1);

  await page.getByTestId("inspector-nav-stream").click();
  await page.getByRole("button", { name: "Load Stream Events" }).click();
  await page.getByTestId("stream-event-card").first().getByRole("button", { name: "Show Payload" }).click();
  await expect(page.getByTestId("stream-event-payload")).toHaveCount(1);
  await expect(page.getByTestId("stream-event-payload-body-preview")).toBeVisible();
  await expect(page.getByTestId("stream-event-payload-body-full")).toHaveCount(0);
  await page.getByTestId("stream-event-payload").getByRole("button", { name: "Show Full Text" }).click();
  await expect(page.getByTestId("stream-event-payload-body-full")).toBeVisible();

  await page.getByTestId("inspector-nav-raw").click();
  await expect(page.getByTestId("raw-payload-card")).toBeVisible();
  await expect(page.getByTestId("raw-payload-body")).toHaveCount(0);
  await page.getByTestId("raw-payload-card").getByRole("button", { name: "Show Payload" }).click();
  await expect(page.getByTestId("raw-payload-body")).toBeVisible();
  await expect(page.getByTestId("raw-payload-text-preview")).toBeVisible();
  await page.getByTestId("raw-payload-body").getByRole("button", { name: "Show Full Text" }).click();
  await expect(page.getByTestId("raw-payload-text-full")).toBeVisible();

  const payloadMetrics = await page.evaluate(() => ({
    streamPayloadHeight: document.querySelector('[data-testid="stream-event-payload"]')?.getBoundingClientRect().height ?? 0,
    rawPayloadHeight: document.querySelector('[data-testid="raw-payload-body"]')?.getBoundingClientRect().height ?? 0,
  }));
  expect(payloadMetrics.streamPayloadHeight).toBeLessThan(700);
  expect(payloadMetrics.rawPayloadHeight).toBeLessThan(700);
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
    const labels = ["Live", "10 min", "1 hour", "Today", "Custom"];
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
const NETWORK_METADATA_CALL_ID = "call-network-metadata";
const NETWORK_METADATA_TS = 1779562600;
const NETWORK_METADATA_MODEL_ID = "us.anthropic.claude-haiku-4-5-20251001-v1:0";
const NETWORK_METADATA_RAW_PATH = "/model/us.anthropic.claude-haiku-4-5-20251001-v1%3A0/converse-stream?X-Amz-Credential=%5Bredacted%5D&trace=abc";
const BLOCK_FILTER_CALL_A_ID = "call-block-filter-a";
const BLOCK_FILTER_CALL_B_ID = "call-block-filter-b";
const BLOCK_FILTER_TS = 1779563000;
const LARGE_CONTENT_CALL_ID = "call-large-content";
const LARGE_CONTENT_TS = 1779563200;
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
  await page.route(/\/api\/token-count$/, async (route) => {
    const body = await route.request().postDataJSON() as {
      readonly subjects?: readonly { readonly type: string; readonly callId?: string; readonly blockId?: string; readonly text?: string }[];
    };
    const subject = body.subjects?.[0];
    await fulfillJson(route, {
      mode: "provider",
      records: [{
        subjectType: subject?.type ?? "block",
        callId: subject?.callId ?? HEAVY_STREAM_CALL_ID,
        ...(subject?.blockId === undefined ? {} : { blockId: subject.blockId }),
        direction: "request",
        kind: "current-user-input",
        label: subject?.type === "selection" ? "selection" : undefined,
        sourceHash: "provider-count-hash",
        modelId: HEAVY_STREAM_MODEL_ID,
        tokens: subject?.type === "selection" ? 5 : 77,
        provenance: "provider_counted",
        countedAt: HEAVY_STREAM_TS + 3,
      }],
    });
  });
  await page.route(/\/api\/calls(?:\?.*)?$/, async (route) => {
    await fulfillJson(route, { items: [fixture.summary] });
  });
  await page.route(/\/api\/search(?:\?.*)?$/, async (route) => {
    await fulfillJson(route, { items: [fixture.summary] });
  });
}

async function installLargeContentRoutes(page: Page, options: {
  readonly expectedSelection?: string | undefined;
  readonly tokenCapture?: { count: number; sawExpectedSelection: boolean; lastLength: number } | undefined;
} = {}): Promise<void> {
  const fixture = largeContentFixture();
  await page.route(/\/api\/health$/, async (route) => {
    await fulfillJson(route, fixture.health);
  });
  await page.route(/\/api\/calls\/call-large-content\/stream-events(?:\?.*)?$/, async (route) => {
    await fulfillJson(route, { items: fixture.streamEvents });
  });
  await page.route(/\/api\/calls\/call-large-content\/diff$/, async (route) => {
    await fulfillJson(route, fixture.diff);
  });
  await page.route(/\/api\/calls\/call-large-content$/, async (route) => {
    await fulfillJson(route, fixture.detail);
  });
  await page.route(/\/api\/token-count$/, async (route) => {
    const body = await route.request().postDataJSON() as {
      readonly subjects?: readonly { readonly type: string; readonly callId?: string; readonly text?: string }[];
    };
    const subject = body.subjects?.[0];
    const selectedText = subject?.text ?? "";
    if (options.tokenCapture !== undefined) {
      options.tokenCapture.count += 1;
      options.tokenCapture.lastLength = selectedText.length;
      options.tokenCapture.sawExpectedSelection = selectedText === options.expectedSelection;
    }
    await fulfillJson(route, {
      mode: "provider",
      records: [{
        subjectType: "selection",
        callId: subject?.callId ?? LARGE_CONTENT_CALL_ID,
        direction: "request",
        kind: "current-user-input",
        label: "selection",
        sourceHash: "large-content-selection-hash",
        modelId: HEAVY_STREAM_MODEL_ID,
        tokens: 12_345,
        provenance: "provider_counted",
        countedAt: LARGE_CONTENT_TS + 3,
      }],
    });
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

async function installCompactionRoutes(page: Page): Promise<void> {
  const fixture = diffScopeFixture();
  const detail: SpyCallDetail = {
    ...fixture.detail,
    compaction: compactionCandidate(fixture.summary),
  };
  await page.route(/\/api\/health$/, async (route) => {
    await fulfillJson(route, fixture.health);
  });
  await page.route(/\/api\/calls\/call-diff-scope-current\/diff$/, async (route) => {
    await fulfillJson(route, fixture.diff);
  });
  await page.route(/\/api\/calls\/call-diff-scope-current$/, async (route) => {
    await fulfillJson(route, detail);
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

async function installNetworkMetadataRoutes(page: Page): Promise<void> {
  const fixture = networkMetadataFixture();
  await page.route(/\/api\/health$/, async (route) => {
    await fulfillJson(route, fixture.health);
  });
  await page.route(/\/api\/calls\/call-network-metadata\/diff$/, async (route) => {
    await fulfillJson(route, fixture.diff);
  });
  await page.route(/\/api\/calls\/call-network-metadata$/, async (route) => {
    await fulfillJson(route, fixture.detail);
  });
  await page.route(/\/api\/calls(?:\?.*)?$/, async (route) => {
    await fulfillJson(route, { items: [fixture.summary] });
  });
  await page.route(/\/api\/search(?:\?.*)?$/, async (route) => {
    await fulfillJson(route, { items: [fixture.summary] });
  });
}

async function installBlockFilterRoutes(page: Page): Promise<void> {
  const fixture = blockFilterFixture();
  await page.route(/\/api\/health$/, async (route) => {
    await fulfillJson(route, fixture.health);
  });
  await page.route(/\/api\/calls\/([^/?]+)\/diff$/, async (route) => {
    const callId = callIdFromRoute(route);
    await fulfillJson(route, fixture.diffs.get(callId));
  });
  await page.route(/\/api\/calls\/([^/?]+)$/, async (route) => {
    const callId = callIdFromRoute(route);
    await fulfillJson(route, fixture.details.get(callId));
  });
  await page.route(/\/api\/calls(?:\?.*)?$/, async (route) => {
    await fulfillJson(route, { items: fixture.summaries });
  });
  await page.route(/\/api\/search(?:\?.*)?$/, async (route) => {
    await fulfillJson(route, { items: fixture.summaries });
  });
}

function callIdFromRoute(route: Route): string {
  const callId = new URL(route.request().url()).pathname.split("/")[3];
  if (callId === undefined || callId.length === 0) {
    throw new Error(`missing call id in route ${route.request().url()}`);
  }
  return callId;
}

function timelineRow(page: Page, callId: string): Locator {
  return page.getByRole("button", { name: new RegExp(`^Open call ${escapeRegExp(callId)},`) });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
    compaction: noCompaction(summary),
    tokenCounts: tokenCountsFor(summary, blocks),
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
    compaction: noCompaction(summary),
    tokenCounts: [],
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

function networkMetadataFixture(): {
  readonly summary: SpyCallSummary;
  readonly detail: SpyCallDetail;
  readonly diff: SpyCallDiff;
  readonly health: SpyServiceHealth;
} {
  const usage = {
    inputTokens: 10,
    outputTokens: 105,
    cacheReadTokens: 5281,
    cacheWriteTokens: 79,
    totalTokens: 5475,
  };
  const call = {
    id: NETWORK_METADATA_CALL_ID,
    provider: "bedrock" as const,
    operation: "converse-stream",
    model_id: NETWORK_METADATA_MODEL_ID,
    status: "complete" as const,
    started_at: NETWORK_METADATA_TS,
    completed_at: NETWORK_METADATA_TS + 1.4,
    status_code: 200,
    request_flow_id: "network-metadata-flow",
    response_flow_id: "network-metadata-flow",
    request_content_hash: "network-metadata-request-hash",
    response_content_hash: "network-metadata-response-hash",
  };
  const summary: SpyCallSummary = {
    call,
    durationMs: 1400,
    usage,
    requestBlockCount: 1,
    responseBlockCount: 1,
    requestByteSize: 1024,
    responseByteSize: 256,
    cacheMarkerCount: 0,
    streamEventCount: 0,
    rawPayloadCount: 0,
  };
  const blocks = [
    blockFilterBlock("network-metadata-request", NETWORK_METADATA_CALL_ID, "request", 0, "current-user-input", "show network metadata"),
    blockFilterBlock("network-metadata-response", NETWORK_METADATA_CALL_ID, "response", 0, "assistant-output", "done"),
  ];
  const detail: SpyCallDetail = {
    summary,
    requestComposition: requestComposition(usage),
    compaction: noCompaction(summary),
    tokenCounts: tokenCountsFor(summary, blocks),
    httpEvents: [
      {
        id: "http-request-network-metadata",
        call_id: NETWORK_METADATA_CALL_ID,
        direction: "request",
        observed_at: NETWORK_METADATA_TS,
        host: "bedrock-runtime.us-east-1.amazonaws.com",
        method: "POST",
        path: NETWORK_METADATA_RAW_PATH,
        headers: [["content-type", "application/json"]],
      },
      {
        id: "http-response-network-metadata",
        call_id: NETWORK_METADATA_CALL_ID,
        direction: "response",
        observed_at: NETWORK_METADATA_TS + 1.4,
        host: "bedrock-runtime.us-east-1.amazonaws.com",
        method: "POST",
        path: NETWORK_METADATA_RAW_PATH,
        status_code: 200,
        reason: "OK",
        headers: [["content-type", "application/vnd.amazon.eventstream; charset=utf-8; x-rootcell-proof=abcdefghijklmnopqrstuvwxyz0123456789"]],
        request_headers: [["authorization", "[redacted]"]],
      },
    ],
    blocks,
    usageRecords: [],
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
    health: healthFixture(1, NETWORK_METADATA_TS),
  };
}

function blockFilterFixture(): {
  readonly summaries: readonly SpyCallSummary[];
  readonly details: ReadonlyMap<string, SpyCallDetail>;
  readonly diffs: ReadonlyMap<string, SpyCallDiff>;
  readonly health: SpyServiceHealth;
} {
  const usage = {
    inputTokens: 1,
    outputTokens: 2,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 3,
  };
  const firstDetail = blockFilterDetail(
    BLOCK_FILTER_CALL_A_ID,
    BLOCK_FILTER_TS,
    "Only appears in request A",
    "Only appears in response A",
    usage,
  );
  const secondDetail = blockFilterDetail(
    BLOCK_FILTER_CALL_B_ID,
    BLOCK_FILTER_TS + 10,
    "Only appears in request B",
    "Only appears in response B",
    usage,
  );
  const details = new Map([
    [BLOCK_FILTER_CALL_A_ID, firstDetail],
    [BLOCK_FILTER_CALL_B_ID, secondDetail],
  ]);
  const diffs = new Map(Array.from(details, ([callId, detail]) => [
    callId,
    {
      call: detail.summary,
      previousCall: null,
      blocks: detail.blocks.map((block) => ({ block, classification: "new" as const })),
    },
  ]));
  return {
    summaries: [firstDetail.summary, secondDetail.summary],
    details,
    diffs,
    health: healthFixture(2, BLOCK_FILTER_TS),
  };
}

function blockFilterDetail(
  callId: string,
  startedAt: number,
  requestText: string,
  responseText: string,
  usage: SpyCallSummary["usage"],
): SpyCallDetail {
  const call = {
    id: callId,
    provider: "bedrock" as const,
    operation: "converse-stream",
    model_id: HEAVY_STREAM_MODEL_ID,
    status: "complete" as const,
    started_at: startedAt,
    completed_at: startedAt + 1,
    status_code: 200,
    request_flow_id: `${callId}-request-flow`,
    response_flow_id: `${callId}-response-flow`,
    request_content_hash: `${callId}-request-hash`,
    response_content_hash: `${callId}-response-hash`,
  };
  const requestByteSize = new TextEncoder().encode(requestText).length;
  const responseByteSize = new TextEncoder().encode(responseText).length;
  const summary: SpyCallSummary = {
    call,
    durationMs: 1000,
    usage,
    requestBlockCount: 1,
    responseBlockCount: 1,
    requestByteSize,
    responseByteSize,
    cacheMarkerCount: 0,
    streamEventCount: 0,
    rawPayloadCount: 0,
  };
  const blocks = [
    blockFilterBlock(`${callId}-request-only`, callId, "request", 0, "current-user-input", requestText),
    blockFilterBlock(`${callId}-response-only`, callId, "response", 0, "assistant-output", responseText),
  ];
  return {
    summary,
    requestComposition: requestComposition(usage),
    compaction: noCompaction(summary),
    tokenCounts: [],
    httpEvents: [],
    blocks,
    usageRecords: [],
    rawPayloads: [],
  };
}

function blockFilterBlock(
  id: string,
  callId: string,
  direction: NormalizedBlock["direction"],
  ordinal: number,
  kind: NormalizedBlock["kind"],
  text: string,
): NormalizedBlock {
  return {
    id,
    call_id: callId,
    direction,
    ordinal,
    kind,
    source: "synthetic-block-filter",
    provider_path: "$.synthetic",
    text,
    char_size: text.length,
    byte_size: new TextEncoder().encode(text).length,
    content_hash: `${id}-hash`,
    cache_marker: false,
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
    compaction: noCompaction(summary),
    tokenCounts: tokenCountsFor(summary, blocks),
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

function largeContentFixture(): {
  readonly summary: SpyCallSummary;
  readonly detail: SpyCallDetail;
  readonly diff: SpyCallDiff;
  readonly health: SpyServiceHealth;
  readonly streamEvents: readonly StreamEvent[];
  readonly largeText: string;
} {
  const usage = {
    inputTokens: 90_000,
    outputTokens: 100,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 90_100,
  };
  const largeText = largeTextFixture("compaction-user-message", 1_600);
  const rawPayloadText = largeTextFixture("raw-provider-payload", 1_000);
  const streamPayloadText = largeTextFixture("stream-provider-payload", 900);
  const requestBlocks = [
    largeContentBlock("large-request-000", "request", 0, "current-user-input", largeText),
    ...Array.from({ length: 139 }, (_, index) => largeContentBlock(
      `large-request-${String(index + 1).padStart(3, "0")}`,
      "request",
      index + 1,
      index % 5 === 0 ? "prior-conversation-history" : "harness-system-context",
      `synthetic context block ${String(index + 1)} ${"ctx ".repeat(20)}`,
    )),
  ];
  const responseBlocks = [
    largeContentBlock("large-response-000", "response", 0, "assistant-output", "large content fixture response"),
  ];
  const blocks = [...requestBlocks, ...responseBlocks];
  const requestByteSize = requestBlocks.reduce((total, block) => total + block.byte_size, 0);
  const responseByteSize = responseBlocks.reduce((total, block) => total + block.byte_size, 0);
  const call = {
    id: LARGE_CONTENT_CALL_ID,
    provider: "bedrock" as const,
    operation: "converse-stream",
    model_id: HEAVY_STREAM_MODEL_ID,
    status: "complete" as const,
    started_at: LARGE_CONTENT_TS,
    completed_at: LARGE_CONTENT_TS + 2,
    status_code: 200,
    request_flow_id: "large-content-flow",
    response_flow_id: "large-content-flow",
    request_content_hash: "large-content-request-hash",
    response_content_hash: "large-content-response-hash",
  };
  const summary: SpyCallSummary = {
    call,
    durationMs: 2000,
    usage,
    requestBlockCount: requestBlocks.length,
    responseBlockCount: responseBlocks.length,
    requestByteSize,
    responseByteSize,
    cacheMarkerCount: 0,
    streamEventCount: 1,
    rawPayloadCount: 1,
  };
  const rawPayload: RawPayloadRecord = {
    id: "raw-large-content-request",
    call_id: LARGE_CONTENT_CALL_ID,
    direction: "request",
    content_type: "application/json",
    body_text: rawPayloadText,
    body_sha256: "raw-large-content-sha",
  };
  const detail: SpyCallDetail = {
    summary,
    requestComposition: {
      ...requestComposition(usage),
      totalBlockCount: requestBlocks.length,
      totalMessageCount: 1,
      totalCharSize: requestBlocks.reduce((total, block) => total + block.char_size, 0),
      totalByteSize: requestByteSize,
    },
    compaction: noCompaction(summary),
    tokenCounts: tokenCountsFor(summary, blocks),
    httpEvents: [],
    blocks,
    usageRecords: [],
    rawPayloads: [rawPayload],
  };
  return {
    summary,
    detail,
    diff: {
      call: summary,
      previousCall: null,
      blocks: requestBlocks.map((block) => ({ block, classification: "new" as const })),
    },
    health: healthFixture(1, LARGE_CONTENT_TS),
    streamEvents: [{
      id: "stream-large-content-000",
      call_id: LARGE_CONTENT_CALL_ID,
      ordinal: 0,
      event_type: "contentBlockDelta",
      headers: {
        ":event-type": "contentBlockDelta",
        ":content-type": "application/json",
      },
      payload: {
        contentBlockIndex: 0,
        delta: {
          text: streamPayloadText,
        },
      },
      payload_sha256: "stream-large-content-sha",
      observed_at: LARGE_CONTENT_TS + 1,
    }],
    largeText,
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
      tokenCountMode: "provider",
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

function noCompaction(summary: SpyCallSummary): SpyCompactionAssessment {
  return {
    status: "none",
    source: "none",
    confidence: "none",
    label: "No compaction candidate",
    reasons: ["no_previous_comparable_call"],
    evidence: {
      currentCallId: summary.call.id,
      previousCallId: null,
      currentRequestByteSize: summary.requestByteSize,
      previousRequestByteSize: null,
      currentInputTokens: summary.usage.inputTokens,
      previousInputTokens: null,
      currentContextTokens: contextTokens(summary.usage),
      previousContextTokens: null,
      currentPriorHistoryByteSize: 0,
      previousPriorHistoryByteSize: null,
      currentPriorHistoryBlockCount: 0,
      previousPriorHistoryBlockCount: null,
      summaryLikeBlockIds: [],
      newHistoryBlockIds: [],
      changedHistoryBlockIds: [],
      repeatedContextBlockCount: 0,
      changedContextBlockCount: 0,
    },
  };
}

function compactionCandidate(summary: SpyCallSummary): SpyCompactionAssessment {
  const currentContextTokens = contextTokens(summary.usage);
  return {
    status: "candidate",
    source: "pi_pattern",
    confidence: "high",
    label: "Pi compaction candidate",
    reasons: [
      "pi_request_context_profile",
      "stable_request_context",
      "summary_like_history_block",
      "prior_history_byte_drop",
      "request_byte_drop",
    ],
    evidence: {
      currentCallId: summary.call.id,
      previousCallId: DIFF_SCOPE_PREVIOUS_CALL_ID,
      currentRequestByteSize: summary.requestByteSize,
      previousRequestByteSize: summary.requestByteSize * 4,
      currentInputTokens: summary.usage.inputTokens,
      previousInputTokens: summary.usage.inputTokens === null ? null : summary.usage.inputTokens * 4,
      currentContextTokens,
      previousContextTokens: currentContextTokens === null ? null : currentContextTokens * 4,
      currentPriorHistoryByteSize: 512,
      previousPriorHistoryByteSize: 8_192,
      currentPriorHistoryBlockCount: 1,
      previousPriorHistoryBlockCount: 6,
      summaryLikeBlockIds: ["compaction-summary-block"],
      newHistoryBlockIds: ["compaction-summary-block"],
      changedHistoryBlockIds: [],
      repeatedContextBlockCount: 2,
      changedContextBlockCount: 0,
    },
  };
}

function contextTokens(usage: SpyCallSummary["usage"]): number | null {
  const parts = [usage.inputTokens, usage.cacheReadTokens, usage.cacheWriteTokens]
    .filter((value): value is number => value !== null);
  return parts.length === 0 ? null : parts.reduce((total, value) => total + value, 0);
}

function tokenCountsFor(summary: SpyCallSummary, blocks: readonly NormalizedBlock[]): SpyTokenCountRecord[] {
  const requestTokens = contextTokens(summary.usage);
  return [
    {
      subjectType: "call",
      callId: summary.call.id,
      direction: "request",
      sourceHash: summary.call.request_content_hash ?? `${summary.call.id}-request-token-hash`,
      modelId: summary.call.model_id,
      tokens: requestTokens,
      provenance: requestTokens === null ? "unavailable" : "provider_counted",
      countedAt: summary.call.started_at,
    },
    ...blocks.map((block): SpyTokenCountRecord => ({
      subjectType: "block",
      callId: summary.call.id,
      blockId: block.id,
      direction: block.direction,
      kind: block.kind,
      sourceHash: block.content_hash,
      modelId: summary.call.model_id,
      tokens: Math.max(1, Math.ceil(block.byte_size / 4)),
      provenance: "provider_counted",
      countedAt: summary.call.started_at,
    })),
  ];
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

function largeContentBlock(
  id: string,
  direction: NormalizedBlock["direction"],
  ordinal: number,
  kind: NormalizedBlock["kind"],
  text: string,
): NormalizedBlock {
  return {
    id,
    call_id: LARGE_CONTENT_CALL_ID,
    direction,
    ordinal,
    kind,
    source: "synthetic-large-content",
    provider_path: "$.synthetic.large",
    text,
    char_size: text.length,
    byte_size: new TextEncoder().encode(text).length,
    content_hash: `${id}-hash`,
    cache_marker: false,
  };
}

function largeTextFixture(label: string, lineCount: number): string {
  return Array.from({ length: lineCount }, (_, index) => (
    `${label} line ${String(index).padStart(4, "0")} ${"ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".repeat(3)}`
  )).join("\n");
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
