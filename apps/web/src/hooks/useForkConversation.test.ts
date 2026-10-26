import { EnvironmentId, ThreadId, AgentSessionForkError } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { toastManager } from "../components/ui/toast";
import { useForkConversation } from "./useForkConversation";

const commands = vi.hoisted(() => ({ fork: vi.fn(), navigate: vi.fn(async () => {}) }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useCallback: (callback: unknown) => callback,
}));
vi.mock("@tanstack/react-router", () => ({ useRouter: () => ({ navigate: commands.navigate }) }));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => commands.fork }));

describe("conversation fork feedback and retry", () => {
  const environmentId = EnvironmentId.make("remote-owner");
  let count = 0;
  const source = () => ({ environmentId, threadId: ThreadId.make(`source-${++count}`) });
  const success = () => {
    commands.fork.mockImplementation(async ({ input }) =>
      AsyncResult.success({ threadId: input.threadId }),
    );
  };

  beforeEach(() => {
    commands.fork.mockReset();
    commands.navigate.mockReset();
    commands.navigate.mockResolvedValue(undefined);
    vi.spyOn(toastManager, "add").mockReturnValue("fork-error");
    success();
  });
  afterEach(() => vi.restoreAllMocks());

  it("shows the server failure and retries the same destination in the owning environment", async () => {
    const target = source();
    commands.fork.mockResolvedValueOnce(
      AsyncResult.failure(
        Cause.fail(
          new AgentSessionForkError({
            message: "The workspace folder no longer exists: /old/project",
          }),
        ),
      ),
    );
    const fork = useForkConversation();
    await fork(target);
    expect(commands.navigate).not.toHaveBeenCalled();
    expect(toastManager.add).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        title: "Could not fork conversation",
        description: "The workspace folder no longer exists: /old/project",
      }),
    );
    const first = commands.fork.mock.calls[0]![0];
    const notice = vi.mocked(toastManager.add).mock.calls[0]![0];
    expect(notice.actionProps?.children).toBe("Retry");
    await notice.actionProps?.onClick?.(undefined as never);
    expect(commands.fork.mock.calls[1]![0]).toEqual(first);
    expect(first.environmentId).toBe(environmentId);
    expect(commands.navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId: first.input.threadId },
    });
    // A stale error toast cannot create a second fork after success.
    await notice.actionProps?.onClick?.(undefined as never);
    expect(commands.fork).toHaveBeenCalledTimes(2);
  });

  it("retains a successful fork when navigation fails and only retries opening it", async () => {
    commands.navigate.mockRejectedValueOnce(new Error("Route unavailable"));
    await expect(useForkConversation()(source())).resolves.toBeUndefined();
    expect(toastManager.add).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        title: "Conversation forked, but could not open it",
        description: "Route unavailable",
      }),
    );
    const notice = vi.mocked(toastManager.add).mock.calls[0]![0];
    expect(notice.actionProps?.children).toBe("Open fork");
    await notice.actionProps?.onClick?.(undefined as never);
    expect(commands.fork).toHaveBeenCalledTimes(1);
    expect(commands.navigate).toHaveBeenCalledTimes(2);
    expect(commands.navigate.mock.calls[1]).toEqual(commands.navigate.mock.calls[0]);
  });

  it("serializes repeated clicks for one source while keeping environments separate", async () => {
    const target = source();
    let complete!: (value: unknown) => void;
    commands.fork.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const fork = useForkConversation();
    const pending = fork(target);
    await useForkConversation()(target);
    expect(commands.fork).toHaveBeenCalledTimes(1);
    const remoteTarget = { ...target, environmentId: EnvironmentId.make("other-owner") };
    await fork(remoteTarget);
    expect(commands.fork).toHaveBeenCalledTimes(2);
    const first = commands.fork.mock.calls[0]![0];
    complete(AsyncResult.success({ threadId: first.input.threadId }));
    await pending;
    expect(commands.navigate).toHaveBeenCalledTimes(2);
    expect(toastManager.add).not.toHaveBeenCalled();
  });

  it("reports rejected transport promises and preserves their retry destination", async () => {
    const target = source();
    commands.fork.mockRejectedValueOnce(new Error("Connection lost"));
    const fork = useForkConversation();
    await expect(fork(target)).resolves.toBeUndefined();
    expect(toastManager.add).toHaveBeenCalledWith(
      expect.objectContaining({ description: "Connection lost" }),
    );
    await fork(target);
    expect(commands.fork.mock.calls[1]).toEqual(commands.fork.mock.calls[0]);
  });
});
