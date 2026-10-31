/**
 * DeepSeek Harness instance settings. Shared by the server driver and the
 * client settings form, so it holds only browser-safe schema code.
 *
 * @module provider-deepseek-harness/settings
 */
import {
  CustomModelSetting,
  makeBinaryPathSetting,
  makeProviderSettingsSchema,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const DeepseekHarnessSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("dsh").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the dsh launcher that boots the ACP profile.",
        providerSettingsForm: { placeholder: "dsh", clearWhenEmpty: "omit" },
      }),
    ),
    profile: Schema.String.pipe(
      Schema.withDecodingDefault(Effect.succeed("acp")),
      Schema.annotateKey({
        title: "DSH profile",
        description: "Profile under $DSH_HOME/profiles that serves ACP. Leave as acp.",
        providerSettingsForm: { placeholder: "acp", clearWhenEmpty: "omit" },
      }),
    ),
    homePath: Schema.String.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "DSH home",
        description:
          "Optional $DSH_HOME override. Empty uses T3's per-instance state directory so profiles stay separate.",
        providerSettingsForm: { placeholder: "~/.dsh", clearWhenEmpty: "omit" },
      }),
    ),
    customModels: Schema.Array(CustomModelSetting).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: ["binaryPath", "profile", "homePath"],
  },
);
export type DeepseekHarnessSettings = typeof DeepseekHarnessSettings.Type;
