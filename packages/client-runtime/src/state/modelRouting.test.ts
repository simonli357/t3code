import { expect, it } from "vite-plus/test";
import { modelEditorUrl } from "./modelRouting.ts";
it("opens the selected remote environment editor without retaining pairing tokens or fragments", () => {
  expect(modelEditorUrl(null, "relay")).toBeNull();
  expect(modelEditorUrl("user@ssh-host", "ssh")).toBeNull();
  expect(modelEditorUrl("wss://myalien.example:444/ws?token=private#old", "myalien")).toBe(
    "https://myalien.example:444/settings/model-selection?machine=myalien",
  );
});
