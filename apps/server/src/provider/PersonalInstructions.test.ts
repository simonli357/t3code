import { describe, it, expect } from "vite-plus/test";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import * as NodeOS from "node:os";
import {
  buildPersonalInstructionContext,
  appendPersonalInstructionContext,
} from "./PersonalInstructions.ts";

describe("personal instruction snapshots", () => {
  it("leaves unconfigured sessions alone", () => {
    expect(buildPersonalInstructionContext(DEFAULT_SERVER_SETTINGS, undefined)).toBeUndefined();
  });
  it("keeps host facts separate and hashes only the effective text", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      personalInstructions: { enabled: true, text: "Use short test answers." },
    };
    const a = buildPersonalInstructionContext(settings, "/job/a")!;
    const b = buildPersonalInstructionContext(
      { ...settings, personalInstructionsGuidePath: "/private/guide" },
      "/job/b",
    )!;
    expect(a.revision).toEqual(b.revision);
    expect(JSON.parse(a.context.runtimeFacts)).toEqual({
      host: NodeOS.hostname(),
      workspace: "/job/a",
    });
    expect(JSON.parse(b.context.runtimeFacts).canonicalGuidePath).toBe("/private/guide");
    expect(a.context.instructions).toContain("user preferences");
    expect(appendPersonalInstructionContext("Question", a.context)).toContain("Question");
  });
  it("replaces active, empty and disabled states without leaking inactive drafts", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      personalInstructions: { enabled: false, text: "Unreviewed draft" },
    };
    expect(buildPersonalInstructionContext(settings, undefined)).toBeUndefined();
    const disabled = buildPersonalInstructionContext(settings, undefined, true)!;
    expect(disabled.context.instructions).not.toContain("Unreviewed draft");
    expect(disabled.context.instructions).toContain("Disregard earlier");
    expect(disabled.active).toBe(false);
    expect(
      buildPersonalInstructionContext(
        { ...settings, personalInstructions: { enabled: true, text: " " } },
        undefined,
        true,
      )?.revision,
    ).toBe(disabled.revision);
  });
});
