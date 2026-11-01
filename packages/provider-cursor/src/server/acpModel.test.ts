import { expect, it } from "vite-plus/test";
import type { SessionConfigOption } from "effect-acp/compat";
import {
  buildCursorCapabilitiesFromConfigOptions,
  resolveCursorAcpBaseModelId,
  resolveCursorAcpConfigUpdates,
} from "./acpModel.ts";

const options: ReadonlyArray<SessionConfigOption> = [
  {
    id: "effort",
    name: "Reasoning",
    category: "model_option",
    type: "select",
    currentValue: "high",
    options: [
      { value: "high", name: "High" },
      { value: "extra-high", name: "Extra high" },
    ],
  },
  {
    id: "context",
    name: "Context",
    category: "model_config",
    type: "select",
    currentValue: "300k",
    options: [
      { value: "300k", name: "300k" },
      { value: "1m", name: "1m" },
    ],
  },
  { id: "fast", name: "Fast", category: "model_config", type: "boolean", currentValue: false },
  {
    id: "thinking",
    name: "Thinking",
    category: "model_config",
    type: "select",
    currentValue: "false",
    options: [
      { value: "true", name: "On" },
      { value: "false", name: "Off" },
    ],
  },
];
it("retains custom.52 option names and maps them back to the live native catalog", () => {
  const descriptors = buildCursorCapabilitiesFromConfigOptions(options).optionDescriptors;
  expect(descriptors?.map((option) => option.id)).toEqual([
    "reasoning",
    "contextWindow",
    "fastMode",
    "thinking",
  ]);
  expect(
    resolveCursorAcpConfigUpdates(options, [
      { id: "reasoning", value: "xhigh" },
      { id: "contextWindow", value: "1m" },
      { id: "fastMode", value: false },
      { id: "thinking", value: true },
    ]),
  ).toEqual([
    { configId: "effort", value: "extra-high" },
    { configId: "context", value: "1m" },
    { configId: "fast", value: false },
    { configId: "thinking", value: "true" },
  ]);
  expect(resolveCursorAcpBaseModelId("auto")).toBe("default");
  expect(resolveCursorAcpBaseModelId("composer[effort=high]")).toBe("composer");
});
