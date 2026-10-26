import { expect, it } from "vite-plus/test";
import { parseCommunicationWindowMinutes } from "./worker-communication";

it("accepts live minute edits including zero and fractions; rejects invalid input", () => {
  expect(parseCommunicationWindowMinutes("0")).toBe(0);
  expect(parseCommunicationWindowMinutes("15")).toBe(15);
  expect(parseCommunicationWindowMinutes("0.5")).toBe(0.5);
  for (const value of ["", " ", "-1", "NaN", "Infinity", "1e300", "abc"])
    expect(parseCommunicationWindowMinutes(value)).toBeUndefined();
});
