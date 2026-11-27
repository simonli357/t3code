// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeNet from "node:net";
import { expect, it } from "vite-plus/test";
import { installBrokenPipeGuard } from "./brokenPipeGuard.ts";

it("contains a child stdin EPIPE after the child explicitly closes its input", async () => {
  const remove = installBrokenPipeGuard();
  const child = NodeChildProcess.spawn(
    process.execPath,
    [
      "-e",
      `
    require("node:fs").closeSync(0);
    process.stdout.write("closed");
    setInterval(() => {}, 60000);
  `,
    ],
    { stdio: "pipe" },
  );
  const exited = NodeEvents.EventEmitter.once(child, "exit");
  try {
    await NodeEvents.EventEmitter.once(child.stdout, "data");
    const error = await new Promise<Error | null | undefined>((resolve) =>
      child.stdin.write("late", resolve),
    );
    expect(error).toMatchObject({ code: "EPIPE" });
  } finally {
    child.kill();
    await exited;
    remove();
  }
});

it("leaves unrelated errors and existing socket error handlers intact", async () => {
  const remove = installBrokenPipeGuard();
  const server = NodeNet.createServer((socket) => socket.resume());
  server.listen(0, "127.0.0.1");
  await NodeEvents.EventEmitter.once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing port");
  const socket = NodeNet.connect(address.port, "127.0.0.1");
  try {
    await NodeEvents.EventEmitter.once(socket, "connect");
    const broken = Object.assign(new Error("broken pipe"), { code: "EPIPE" });
    const observed: unknown[] = [];
    socket.once("error", (error) => observed.push(error));
    socket.emit("error", broken);
    expect(observed).toEqual([broken]);
    expect(() => socket.emit("error", broken)).not.toThrow();
    expect(() => socket.emit("error", new Error("unrelated"))).toThrow("unrelated");
  } finally {
    socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    remove();
  }
});
