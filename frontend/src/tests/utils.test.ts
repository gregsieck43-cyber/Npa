import { describe, expect, it } from "vitest";
import { defaultVista, formatDuration, formatTokens, normalizeBootstrap, percent, statusLabel } from "../lib/utils";

describe("workbench display helpers", () => {
  it("formats token counts without noisy decimals", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(1_200)).toBe("1.2k");
    expect(formatTokens(12_000)).toBe("12k");
    expect(formatTokens(2_000_000)).toBe("2.0M");
  });

  it("formats durations across minute and hour boundaries", () => {
    expect(formatDuration(0)).toBe("0m");
    expect(formatDuration(42_000)).toBe("42s");
    expect(formatDuration(125_000)).toBe("2m 5s");
    expect(formatDuration(3_720_000)).toBe("1h 2m");
  });

  it("maps persisted statuses to human labels", () => {
    expect(statusLabel("waiting_approval")).toBe("等待审批");
    expect(statusLabel("unknown_status")).toBe("unknown status");
    expect(statusLabel(undefined)).toBe("未开始");
  });

  it("clamps progress values and supplies a safe VISTA default", () => {
    expect(percent(130, 100)).toBe(100);
    expect(percent(-4, 100)).toBe(0);
    expect(percent(2, 0)).toBe(0);
    expect(defaultVista().blocks.filter((block) => block.pinned)).toHaveLength(3);
  });

  it("normalizes an empty or nested bootstrap response", () => {
    const empty = normalizeBootstrap(null);
    expect(empty.connected).toBe(true);
    expect(empty.timeline.length).toBeGreaterThan(0);
    const nested = normalizeBootstrap({ data: { projects: [{ id: "p1", name: "Demo" }], timeline: [] } });
    expect(nested.projects[0]?.name).toBe("Demo");
    expect(nested.vista.blocks.length).toBeGreaterThan(0);
  });
});
