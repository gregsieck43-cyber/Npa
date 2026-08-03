import { describe, expect, it } from "vitest";
import { isSafeTerminalCommand, parseDataPreview } from "../components/FeaturePanels";
import { normalizeRunEvent } from "../lib/api";

describe("feature panel pure boundaries", () => {
  it("previews JSON rows and CSV columns consistently", () => {
    expect(parseDataPreview('[{"name":"a","value":1},{"name":"b","value":2}]')).toEqual({
      columns: ["name", "value"],
      rows: [{ name: "a", value: 1 }, { name: "b", value: 2 }],
    });
    expect(parseDataPreview("name,value\na,1\nb,2")).toEqual({
      columns: ["name", "value"],
      rows: [{ name: "a", value: "1" }, { name: "b", value: "2" }],
    });
  });

  it("keeps terminal actions inside the server whitelist shape", () => {
    expect(isSafeTerminalCommand("npm test")).toBe(true);
    expect(isSafeTerminalCommand("npm run test:frontend -- --run")).toBe(true);
    expect(isSafeTerminalCommand("node --test test/example.test.mjs")).toBe(true);
    expect(isSafeTerminalCommand("git status --short")).toBe(false);
    expect(isSafeTerminalCommand("npm run lint")).toBe(false);
    expect(isSafeTerminalCommand("npm.cmd test")).toBe(false);
    expect(isSafeTerminalCommand("powershell Remove-Item important.txt")).toBe(false);
    expect(isSafeTerminalCommand("npm install evil-package")).toBe(false);
  });

  it("normalizes raw runner events for the unified timeline", () => {
    const event = normalizeRunEvent({ id: "event-1", type: "tool.completed", createdAt: "2026-08-03T00:00:00.000Z", payload: { kind: "git", status: "completed" } });
    expect(event.type).toBe("tool");
    expect(event.title).toContain("工具完成");
    expect(event.status).toBe("success");
    expect(event.timestamp).toBe("2026-08-03T00:00:00.000Z");
  });

  it("keeps lifecycle, approval, and artifact events typed for the timeline", () => {
    expect(normalizeRunEvent({ id: "step-test", type: "step.updated", payload: { step: { type: "test", status: "passed" } } }).type).toBe("test");
    expect(normalizeRunEvent({ id: "step-commit", type: "step.updated", payload: { step: { type: "commit", status: "completed" } } }).type).toBe("commit");
    const approval = normalizeRunEvent({ id: "approval", type: "approval.requested", payload: { action: "terminal.run" } });
    expect(approval.type).toBe("approval");
    expect(approval.status).toBe("warning");
    expect(normalizeRunEvent({ id: "diff", type: "diff.updated", payload: { status: "completed" } }).type).toBe("diff");
    expect(normalizeRunEvent({ id: "artifact", type: "artifact.updated", payload: { kind: "commit" } }).type).toBe("commit");
  });
});
