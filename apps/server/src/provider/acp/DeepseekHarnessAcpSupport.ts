import {
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type DeepseekHarnessSettings,
  type ProviderSendTurnInput,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const TEXT_MIME_TYPES = new Set([
  "application/json",
  "application/javascript",
  "application/typescript",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
  "application/x-sh",
]);
const TEXT_FILE_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".mdx",
  ".json",
  ".jsonl",
  ".yaml",
  ".yml",
  ".toml",
  ".xml",
  ".csv",
  ".tsv",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".html",
  ".css",
  ".scss",
  ".py",
  ".rs",
  ".go",
  ".java",
  ".kt",
  ".swift",
  ".c",
  ".h",
  ".cc",
  ".cpp",
  ".hpp",
  ".cs",
  ".rb",
  ".php",
  ".sh",
  ".bash",
  ".zsh",
  ".sql",
  ".log",
  ".diff",
  ".patch",
  ".ini",
  ".conf",
]);
const MAX_INLINE_TEXT_BYTES = 1024 * 1024;

/** DSH fork commit containing the T3 ACP lifecycle used by this adapter. */
export const DEEPSEEK_HARNESS_T3_COMMIT = "60052b5d4fe3dce42b8c5ce3e6ef60885f906ca6";
export const DEEPSEEK_HARNESS_T3_SOURCE =
  `https://github.com/simonli357/deepseek-harness/tree/${DEEPSEEK_HARNESS_T3_COMMIT}`;

export interface DeepseekHarnessAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "cancelBehavior" | "clientCapabilities" | "resumeMethod" | "spawn"
> {
  readonly settings: DeepseekHarnessSettings;
  readonly dshHome: string;
  readonly apiKey: string | undefined;
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly baseEnvironment?: NodeJS.ProcessEnv;
  readonly agentDeviceEnvironment?: Readonly<Record<string, string>>;
  readonly workspaceEnvironment?: Readonly<Record<string, string>>;
}

export const makeDeepseekHarnessAcpRuntime = Effect.fn("makeDeepseekHarnessAcpRuntime")(
  function* (input: DeepseekHarnessAcpRuntimeInput) {
    const context = yield* Layer.build(
      AcpSessionRuntime
        .layer({
          ...input,
          authMethodId: "deepseek-api-key",
          resumeMethod: "load",
          cancelBehavior: "wait-for-prompt",
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          spawn: {
            command: input.settings.binaryPath.trim() || "dsh",
            args: ["--profile", input.settings.profile.trim() || "acp"],
            cwd: input.cwd,
            env: {
              ...(input.baseEnvironment ?? process.env),
              ...input.agentDeviceEnvironment,
              ...input.workspaceEnvironment,
              DSH_HOME: input.dshHome,
              DSH_TELEMETRY_DISABLED: "1",
              ...(input.apiKey ? { DEEPSEEK_API_KEY: input.apiKey } : {}),
            },
          },
        })
        .pipe(
          Layer.provide(
            Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
          ),
        ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(context),
    );
  },
);

export const DEEPSEEK_HARNESS_CANCEL_TIMEOUT = "20 seconds";

export function deepseekHarnessPermissionMode(runtimeMode: RuntimeMode): string {
  return runtimeMode === "full-access" ? "danger-full-access" : "workspace-write";
}

export function deepseekHarnessModelSlug(optionValue: string): string {
  try {
    const parsed: unknown = JSON.parse(optionValue);
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === "string" &&
      typeof parsed[1] === "string"
    ) {
      return `${parsed[0]}/${parsed[1]}`;
    }
  } catch {}
  return optionValue;
}

export function deepseekHarnessModelOption(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
  slug: string | null | undefined,
): string | undefined {
  const model = configOptions.find((option) => option.id === "model");
  if (model?.type !== "select") return undefined;
  if (!slug) return model.currentValue;
  const values = model.options.flatMap((entry) =>
    "value" in entry ? [entry.value] : entry.options.map((option) => option.value),
  );
  return values.find((value) => {
    const qualified = deepseekHarnessModelSlug(value);
    return (
      value === slug ||
      qualified === slug ||
      qualified.slice(qualified.lastIndexOf("/") + 1) === slug
    );
  });
}

export const applyDeepseekHarnessModelSelection = Effect.fn(
  "applyDeepseekHarnessModelSelection",
)(function* <E>(input: {
  readonly runtime: Pick<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    "getConfigOptions" | "setModel" | "setConfigOption"
  >;
  readonly model: string | null | undefined;
  readonly reasoningEffort?: string | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.fn.Return<string | undefined, E> {
  const options = yield* input.runtime.getConfigOptions;
  const option = deepseekHarnessModelOption(options, input.model);
  if (option !== undefined) {
    yield* input.runtime.setModel(option).pipe(Effect.mapError(input.mapError));
  }
  if (input.reasoningEffort !== undefined) {
    yield* input.runtime
      .setConfigOption("reasoning_effort", input.reasoningEffort)
      .pipe(Effect.mapError(input.mapError));
  }
  return option === undefined ? undefined : deepseekHarnessModelSlug(option);
});

export const buildDeepseekHarnessPrompt = Effect.fn("buildDeepseekHarnessPrompt")(function* (input: {
  readonly input: ProviderSendTurnInput["input"];
  readonly attachments: ProviderSendTurnInput["attachments"];
  readonly attachmentsDir: string;
}): Effect.fn.Return<
  ReadonlyArray<EffectAcpSchema.ContentBlock>,
  EffectAcpErrors.AcpError,
  FileSystem.FileSystem | Path.Path
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const blocks: Array<EffectAcpSchema.ContentBlock> = [];
  if (input.input?.trim()) blocks.push({ type: "text", text: input.input.trim() });
  let totalBytes = 0;
  for (const attachment of input.attachments ?? []) {
    const attachmentPath = resolveAttachmentPath({
      attachmentsDir: input.attachmentsDir,
      attachment,
    });
    if (!attachmentPath) {
      return yield* EffectAcpErrors.AcpRequestError.invalidParams(
        `Invalid attachment '${attachment.name}'.`,
      );
    }
    const mimeType = attachment.mimeType.toLowerCase().split(";", 1)[0] ?? "";
    const image = attachment.type === "image" && IMAGE_MIME_TYPES.has(mimeType);
    const textFile =
      attachment.type === "file" &&
      (mimeType.startsWith("text/") ||
        TEXT_MIME_TYPES.has(mimeType) ||
        TEXT_FILE_EXTENSIONS.has(path.extname(attachment.name).toLowerCase()));
    if (!image && !textFile) continue;
    const info = yield* fileSystem
      .stat(attachmentPath)
      .pipe(
        Effect.mapError(() =>
          EffectAcpErrors.AcpRequestError.invalidParams(
            `Could not read attachment '${attachment.name}'.`,
          ),
        ),
      );
    if (info.type !== "File") continue;
    const size = Number(info.size);
    const limit = image ? PROVIDER_SEND_TURN_MAX_IMAGE_BYTES : MAX_INLINE_TEXT_BYTES;
    if (size > limit || totalBytes + size > PROVIDER_SEND_TURN_MAX_FILE_BYTES) continue;
    totalBytes += size;
    const bytes = yield* fileSystem.stream(attachmentPath, { bytesToRead: limit + 1 }).pipe(
      Stream.runCollect,
      Effect.map((chunks) => Buffer.concat(chunks)),
      Effect.mapError(() =>
        EffectAcpErrors.AcpRequestError.invalidParams(
          `Could not read attachment '${attachment.name}'.`,
        ),
      ),
    );
    if (bytes.length > limit || totalBytes > PROVIDER_SEND_TURN_MAX_FILE_BYTES) continue;
    if (image) {
      blocks.push({
        type: "image",
        data: Buffer.from(bytes).toString("base64"),
        mimeType,
      });
      continue;
    }
    const text = yield* Effect.try({
      try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      catch: () =>
        EffectAcpErrors.AcpRequestError.invalidParams(
          `Attachment '${attachment.name}' is not UTF-8 text.`,
        ),
    });
    blocks.push({
      type: "text",
      text: `<attached-file name=${JSON.stringify(attachment.name)}>\n${text}\n</attached-file>`,
    });
  }
  if (blocks.length === 0) {
    return yield* EffectAcpErrors.AcpRequestError.invalidParams(
      "A turn requires text or a supported attachment.",
    );
  }
  return blocks;
});
