import { describe, it, expect } from "vite-plus/test";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import * as NodeOS from "node:os";
import {
  buildGlobalInstructionContext,
  appendGlobalInstructionContext,
} from "./GlobalInstructions.ts";

it("reports the retained launch workspace separately from expiring jobs", () => {
  const settings = {
    ...DEFAULT_SERVER_SETTINGS,
    globalInstructions: { enabled: true, text: "Keep work" },
  };
  const workspace = "/sessions/id/repo";
  const launchEnvironment = {
    WORKENV_JOB_ROOT: "/sessions/id",
    WORKENV_JOB_REPO: workspace,
    TMPDIR: "/sessions/id/tmp",
  };
  const context = buildGlobalInstructionContext(
    settings,
    workspace,
    false,
    null,
    launchEnvironment,
  )!;
  const facts = JSON.parse(context.context.runtimeFacts);
  expect(facts.retainedWorkspace.root).toBe("/sessions/id");
  expect(facts.retainedWorkspace.launchEnvironment.TMPDIR).toBe("/sessions/id/tmp");
  expect(facts.sessionWorkspace).toBeUndefined();
  const disabled = buildGlobalInstructionContext(
    { ...settings, globalInstructions: { enabled: false, text: "Ignored instructions" } },
    workspace,
    false,
    null,
    launchEnvironment,
  )!;
  expect(disabled.active).toBe(false);
  expect(JSON.parse(disabled.context.runtimeFacts).retainedWorkspace).toEqual(
    facts.retainedWorkspace,
  );
  expect(disabled.context.instructions).not.toContain("Ignored instructions");
});

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
