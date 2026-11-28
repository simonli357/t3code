const ANTIGRAVITY_RELEASE_VERSION = "1.5.2";

export interface AntigravityReleaseAsset {
  readonly version: string;
  readonly url: string;
  readonly sha256: string;
  readonly archiveBytes: number;
  readonly executable: {
    readonly name: string;
    readonly bytes: number;
  };
  readonly harness: {
    readonly name: string;
    readonly bytes: number;
  };
}

// URLs come from the official registry. Hashes and sizes were checked on 2026-11-28.
// https://github.com/agentclientprotocol/registry/blob/e29b5bf3bfd8756db5d901690b43dc31e926ccd5/antigravity-acp/agent.json
const releaseAssets = new Map<string, AntigravityReleaseAsset>([
  [
    "darwin-arm64",
    {
      version: ANTIGRAVITY_RELEASE_VERSION,
      url: "https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.5.2-darwin-arm64.zip",
      sha256: "123a16d5c40a8ac99e20f01a62b68dd860fd96b1c528dfb8eaa37ca8733d4845",
      archiveBytes: 100_309_778,
      executable: { name: "agy_acp_server.par", bytes: 179_921_328 },
      harness: { name: "localharness_external", bytes: 129_208_672 },
    },
  ],
  [
    "linux-x64",
    {
      version: ANTIGRAVITY_RELEASE_VERSION,
      url: "https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.5.2-linux-x86_64.zip",
      sha256: "99dd8612450805011619d7b8447ce374c289e00549d8557f36790e1dd6256852",
      archiveBytes: 273_964_075,
      executable: { name: "agy_acp_server.par", bytes: 714_384_320 },
      harness: { name: "localharness_external", bytes: 139_194_456 },
    },
  ],
  [
    "linux-arm64",
    {
      version: ANTIGRAVITY_RELEASE_VERSION,
      url: "https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.5.2-linux-arm64.zip",
      sha256: "e729e05ef54ef0763e48900032466b47fa7c9939cde257f93ba49410ab577acb",
      archiveBytes: 264_270_419,
      executable: { name: "agy_acp_server.par", bytes: 721_649_155 },
      harness: { name: "localharness_external", bytes: 132_598_576 },
    },
  ],
  [
    "win32-x64",
    {
      version: ANTIGRAVITY_RELEASE_VERSION,
      url: "https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.5.2-windows-x86_64.zip",
      sha256: "5cbadd4f4df698572473d8890fc26ec2dc1724501f06e3a963941daec2bd21d6",
      archiveBytes: 105_407_645,
      executable: { name: "agy_acp_server.exe", bytes: 58_368_800 },
      harness: { name: "localharness_external.exe", bytes: 155_357_336 },
    },
  ],
  [
    "win32-arm64",
    {
      version: ANTIGRAVITY_RELEASE_VERSION,
      url: "https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.5.2-windows-arm64.zip",
      sha256: "8a4b2ea8df2ffefae33309348752e9119d21a6d36090c0eb48631c2e8f5781ab",
      archiveBytes: 108_049_351,
      executable: { name: "agy_acp_server.exe", bytes: 65_130_848 },
      harness: { name: "localharness_external.exe", bytes: 146_707_096 },
    },
  ],
]);

export function resolveAntigravityReleaseAsset(
  platform: NodeJS.Platform,
  arch: string,
): AntigravityReleaseAsset | null {
  return releaseAssets.get(`${platform}-${arch}`) ?? null;
}
