import { describe, expect, test } from "bun:test";
import { blockKindLabel, formatBytes, formatDuration, secondsForPreset, shortModelId } from "./format.ts";

describe("spy UI format helpers", () => {
  test("formats byte sizes", () => {
    expect(formatBytes(999)).toBe("999 B");
    expect(formatBytes(2048)).toBe("2.0 KiB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MiB");
  });

  test("formats durations", () => {
    expect(formatDuration(null)).toBe("pending");
    expect(formatDuration(250)).toBe("250 ms");
    expect(formatDuration(1250)).toBe("1.3 s");
  });

  test("derives preset timestamps", () => {
    const now = new Date("2026-05-23T12:30:00Z");
    expect(secondsForPreset("10m", now)).toBe(Math.floor(now.getTime() / 1000) - 600);
    expect(secondsForPreset("1h", now)).toBe(Math.floor(now.getTime() / 1000) - 3600);
  });

  test("formats model and block labels", () => {
    expect(shortModelId("us.anthropic.claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
    expect(blockKindLabel("current-user-input")).toBe("Current User Input");
  });
});
