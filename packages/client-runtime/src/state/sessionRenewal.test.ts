import { expect, it } from "vite-plus/test";

import { renewalFieldPatch } from "./sessionRenewal.ts";
import { parseCommunicationWindowMinutes } from "./workerCommunication.ts";

it("turns a blank hard limit off and rejects blanks and out-of-range values elsewhere", () => {
  expect(renewalFieldPatch("workerHardHours", "")).toEqual({ workerHardHours: null });
  expect(renewalFieldPatch("workerHardHours", "6")).toEqual({ workerHardHours: 6 });
  expect(renewalFieldPatch("workerHours", "")).toBeNull();
  expect(renewalFieldPatch("codexScale", "50")).toBeNull();
  expect(renewalFieldPatch("masterHours", "abc")).toBeNull();
});

it("accepts zero or more minutes for the communication window", () => {
  expect(parseCommunicationWindowMinutes("0")).toBe(0);
  expect(parseCommunicationWindowMinutes("7.5")).toBe(7.5);
  expect(parseCommunicationWindowMinutes("")).toBeUndefined();
  expect(parseCommunicationWindowMinutes("-1")).toBeUndefined();
});
