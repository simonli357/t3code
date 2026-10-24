import { describe, it, expect } from "vite-plus/test";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import * as NodeOS from "node:os";
import {
  buildGlobalInstructionContext,
  appendGlobalInstructionContext,
} from "./GlobalInstructions.ts";

describe("global instruction snapshots", () => {
  it("leaves unconfigured sessions alone", () => {
    expect(buildGlobalInstructionContext(DEFAULT_SERVER_SETTINGS, undefined)).toBeUndefined();
  });
  it("keeps host facts separate and hashes only the effective text", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      globalInstructions: { enabled: true, text: "Use short test answers." },
    };
    const a = buildGlobalInstructionContext(settings, "/job/a")!;
    const b = buildGlobalInstructionContext(
      { ...settings, globalInstructionsGuidePath: "/private/guide" },
      "/job/b",
    )!;
    expect(a.revision).toEqual(b.revision);
    expect(JSON.parse(a.context.runtimeFacts)).toEqual({
      host: NodeOS.hostname(),
      workspace: "/job/a",
    });
    expect(JSON.parse(b.context.runtimeFacts).guidePath).toBe("/private/guide");
    expect(a.context.instructions).toContain("user preferences");
    expect(appendGlobalInstructionContext("Question", a.context)).toContain("Question");
  });
  it("replaces active, empty and disabled states without leaking inactive drafts", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      globalInstructions: { enabled: false, text: "Unreviewed draft" },
    };
    expect(buildGlobalInstructionContext(settings, undefined)).toBeUndefined();
    const disabled = buildGlobalInstructionContext(settings, undefined, true)!;
    expect(disabled.context.instructions).not.toContain("Unreviewed draft");
    expect(disabled.context.instructions).toContain("Disregard earlier");
    expect(disabled.active).toBe(false);
    expect(
      buildGlobalInstructionContext(
        { ...settings, globalInstructions: { enabled: true, text: " " } },
        undefined,
        true,
      )?.revision,
    ).toBe(disabled.revision);
  });
});
