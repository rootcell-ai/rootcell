import { describe, expect, test } from "bun:test";
import { callsUrl, streamEventsUrl } from "./api.ts";

describe("spy UI API helpers", () => {
  test("builds call list URLs with since and cursors", () => {
    expect(callsUrl({ since: 123, cursor: "next", limit: 25 })).toBe("/api/calls?limit=25&cursor=next&since=123");
  });

  test("uses search endpoint when query text is present", () => {
    expect(callsUrl({ since: 123, search: "fixture capture" })).toBe("/api/search?limit=100&q=fixture+capture");
  });

  test("encodes stream event call ids", () => {
    expect(streamEventsUrl("call/one", "cursor:1")).toBe("/api/calls/call%2Fone/stream-events?limit=100&cursor=cursor%3A1");
  });
});
