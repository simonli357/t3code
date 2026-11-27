// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeDiagnosticsChannel from "node:diagnostics_channel";
import * as NodeEvents from "node:events";
import * as NodeNet from "node:net";

// A buffered write can finish after a provider's stdin sink or a socket's
// request handler has released its error listener. Preserve the owner's
// normal error handling and contain only an otherwise unhandled broken pipe.
function observeBrokenPipe(this: NodeEvents.EventEmitter, error: NodeJS.ErrnoException) {
  if (error.code === "EPIPE" && this.listenerCount("error") === 0) {
    this.once("error", () => {});
  }
}

function guard(stream: NodeEvents.EventEmitter) {
  stream.on(NodeEvents.errorMonitor, observeBrokenPipe);
}

export function installBrokenPipeGuard() {
  const sockets = NodeDiagnosticsChannel.channel("net.client.socket");
  const acceptedSockets = NodeDiagnosticsChannel.channel("net.server.socket");
  const children = NodeDiagnosticsChannel.channel("child_process");
  const onSocket = (message: unknown) => {
    if (
      message &&
      typeof message === "object" &&
      "socket" in message &&
      message.socket instanceof NodeNet.Socket
    ) {
      guard(message.socket);
    }
  };
  const onChild = (message: unknown) => {
    if (
      message &&
      typeof message === "object" &&
      "process" in message &&
      message.process instanceof NodeChildProcess.ChildProcess
    ) {
      const child = message.process;
      // Node publishes the ChildProcess before spawn creates its stdio pipes.
      child.once("spawn", () => {
        if (child.stdin) guard(child.stdin);
      });
    }
  };
  sockets.subscribe(onSocket);
  acceptedSockets.subscribe(onSocket);
  children.subscribe(onChild);
  guard(process.stdout);
  guard(process.stderr);
  return () => {
    sockets.unsubscribe(onSocket);
    acceptedSockets.unsubscribe(onSocket);
    children.unsubscribe(onChild);
    process.stdout.off(NodeEvents.errorMonitor, observeBrokenPipe);
    process.stderr.off(NodeEvents.errorMonitor, observeBrokenPipe);
  };
}
