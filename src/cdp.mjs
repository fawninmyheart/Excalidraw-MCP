import { setTimeout as delay } from "node:timers/promises";
import { loadConfig } from "./config.mjs";

export async function connectCanvas(config = loadConfig()) {
  const response = await fetch(`${config.cdpUrl}/json/list`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`CDP discovery failed: HTTP ${response.status}`);
  const targets = (await response.json()).filter((target) => {
    if (target.type !== "page") return false;
    const url = new URL(target.url);
    return url.origin === new URL(config.appUrl).origin && url.pathname === "/";
  });
  if (targets.length !== 1) {
    throw new Error(`Expected one local Excalidraw canvas, found ${targets.length}. Open the Excalidraw-MCP shortcut or run start.ps1 and keep one canvas window open.`);
  }
  const target = targets[0];
  const endpoint = new URL(target.webSocketDebuggerUrl);
  if (endpoint.protocol !== "ws:" || endpoint.hostname !== "127.0.0.1" || endpoint.port !== String(config.cdpPort)) {
    throw new Error("CDP returned an unexpected debugger endpoint.");
  }
  const socket = new WebSocket(endpoint);
  const pending = new Map();
  let nextId = 0;
  function rejectPending(error) {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  }
  socket.addEventListener("error", () => rejectPending(new Error("CDP WebSocket failed")));
  socket.addEventListener("close", () => rejectPending(new Error("CDP WebSocket closed")));
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(`${message.error.message} (${message.error.code})`));
    else request.resolve(message.result);
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error("CDP connection timed out")); }, 30000);
    const finish = (error) => { clearTimeout(timer); error ? reject(error) : resolve(); };
    socket.addEventListener("open", () => finish(), { once: true });
    socket.addEventListener("error", () => finish(new Error("CDP connection failed")), { once: true });
    socket.addEventListener("close", () => finish(new Error("CDP connection closed")), { once: true });
  });

  function call(method, params = {}, timeout = 30000) {
    return new Promise((resolve, reject) => {
      if (socket.readyState !== WebSocket.OPEN) { reject(new Error("CDP is not connected")); return; }
      const id = ++nextId;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, timeout);
      pending.set(id, { resolve, reject, timer });
      try { socket.send(JSON.stringify({ id, method, params })); } catch (error) {
        pending.delete(id); clearTimeout(timer); reject(error);
      }
    });
  }
  async function evaluate(expression, timeout = 30000) {
    const reply = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, timeout);
    if (reply.exceptionDetails) {
      throw new Error(reply.exceptionDetails.exception?.description || reply.exceptionDetails.text);
    }
    return reply.result.value;
  }
  return {
    call, evaluate, url: target.url,
    close() { rejectPending(new Error("CDP disconnected")); socket.close(); },
  };
}

export async function waitReady(client) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      if (await client.evaluate("Boolean(window.excalidrawLocal?.isReady())", Math.max(1, deadline - Date.now()))) return;
    } catch (error) {
      if (!/Cannot find.*context|Execution context was destroyed/i.test(error.message)) throw error;
    }
    await delay(Math.min(100, Math.max(0, deadline - Date.now())));
  }
  throw new Error("Local Excalidraw did not become ready within 30 seconds");
}
