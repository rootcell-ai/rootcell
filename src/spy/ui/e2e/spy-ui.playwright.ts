import { expect, test } from "@playwright/test";

test.describe.configure({ mode: "serial" });

test("loads fixture calls and receives live updates", async ({ page }) => {
  await page.goto("/?since=0");
  await expect(page.getByRole("heading", { name: "Rootcell Spy" })).toBeVisible();
  await expect(page.getByTestId("timeline-row")).toHaveCount(4);
  await expect(page.getByTestId("timeline-row")).toHaveCount(5);
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
  await page.getByText("Health", { exact: true }).click();
  await expect(page.getByText("Enabled", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("DB size", { exact: true })).toBeVisible();
  await expect(page.getByText("Spool size", { exact: true })).toBeVisible();
  await expect(page.getByText("Store cap", { exact: true })).toBeVisible();
  await expect(page.getByText("Spool cap", { exact: true })).toBeVisible();
  await expect(page.getByText("Retention", { exact: true })).toBeVisible();
  await expect(page.getByText("Dropped captures", { exact: true })).toBeVisible();
  await expect(page.getByText("Last ingest", { exact: true })).toBeVisible();
});

test("loads historical ranges and searches normalized text", async ({ page }) => {
  await page.goto("/?since=0");
  await page.getByRole("button", { name: "10 min" }).click();
  await expect(page.getByTestId("timeline-row").first()).toBeVisible();
  await page.getByLabel("Filter by provider").selectOption("bedrock");
  await page.getByLabel("Filter by operation").selectOption("invoke");
  await expect(page.getByText("No provider calls in this range.")).toBeVisible();
  await page.getByLabel("Search normalized text").fill("Fixture capture");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.getByText("No provider calls in this range.")).toBeVisible();
  await page.getByLabel("Filter by operation").selectOption("converse-stream");
  await expect(page.getByTestId("timeline-row").first()).toBeVisible();
});

test("loads stream events on demand", async ({ page }) => {
  await page.goto("/?since=0");
  await expect(page.getByTestId("timeline-row")).toHaveCount(5);
  await page.getByTestId("timeline-row").first().click();
  await page.getByText("Stream Events", { exact: true }).click();
  await page.getByRole("button", { name: "Load Stream Events" }).click();
  await expect(page.getByText("messageStart").first()).toBeVisible();
});

test("clears data with confirmation", async ({ page }) => {
  await page.goto("/?since=0");
  await expect(page.getByTestId("timeline-row")).toHaveCount(5);
  await page.getByLabel("Clear spy data").click();
  await expect(page.getByRole("dialog", { name: "Clear Spy Data" })).toBeVisible();
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  await expect(page.getByText("No provider calls in this range.")).toBeVisible();
});
