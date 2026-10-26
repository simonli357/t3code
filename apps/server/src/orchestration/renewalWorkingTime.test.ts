import { expect, it } from "vite-plus/test";
import { renewalWorkingHours } from "./renewalWorkingTime.ts";

const at = (hours: number) => new Date(hours * 3_600_000).toISOString();
const span = (start: number, end: number | null) => ({
  start: at(start),
  end: end === null ? null : at(end),
});
it("excludes concurrent and unfinished long tool waits once, only during work", () => {
  expect(
    renewalWorkingHours(
      [span(0, 2), span(4, null)],
      [span(0.5, 1.5), span(1, 2), span(2, 4), span(4.5, null)],
      5 * 3_600_000,
      60,
    ),
  ).toBe(1);
});
it("ignores malformed intervals and keeps short tool calls as working time", () => {
  expect(
    renewalWorkingHours(
      [span(0, 1), { start: null, end: null }],
      [span(0, 0.01), { start: "bad", end: null }],
      3_600_000,
      60,
    ),
  ).toBe(1);
});
