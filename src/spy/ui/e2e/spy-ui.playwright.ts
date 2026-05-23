import { expect, test } from "@playwright/test";

test.describe.configure({ mode: "serial" });

test("loads fixture calls and receives live updates", async ({ page }) => {
  await page.goto("/?since=0");
  await expect(page.getByRole("heading", { name: "Rootcell Spy" })).toBeVisible();
  await expect(page.getByTestId("timeline-row")).toHaveCount(4);
  await expect(page.getByTestId("timeline-row")).toHaveCount(5);
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
