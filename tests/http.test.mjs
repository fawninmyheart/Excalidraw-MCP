import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";

test("HTTP serves a Unicode installation with explicit UTF-8 health and local-only requests", { timeout: 15000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "excalidraw-http-"));
  const buildDir = path.join(root, "中文 build");
  const reservation = net.createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const appPort = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  await mkdir(buildDir);
  await writeFile(path.join(buildDir, "index.html"), "<!doctype html><title>Local canvas</title>");
  await writeFile(path.join(root, "installation.json"), JSON.stringify({
    installDir: root, toolDir: root, buildDir, nodePath: process.execPath,
    browserPath: process.execPath, profileDir: path.join(root, "profile"), appPort, cdpPort: appPort === 9230 ? 9231 : 9230,
  }));
  const server = spawn(process.execPath, [fileURLToPath(new URL("../src/http-server.mjs", import.meta.url))], {
    env: { ...process.env, EXCALIDRAW_MCP_HOME: root }, windowsHide: true, stdio: "ignore",
  });
  const exited = once(server, "exit");
  try {
    const url = `http://127.0.0.1:${appPort}`;
    let health;
    for (let i = 0; i < 50; i++) {
      try { health = await fetch(`${url}/__local_health`); break; } catch { await delay(100); }
    }
    assert(health, "Server must become ready");
    assert.match(health.headers.get("content-type"), /charset=utf-8/i);
    assert.equal((await health.json()).root, buildDir);
    assert.match(await (await fetch(url)).text(), /Local canvas/);
    assert.equal((await fetch(url, { method: "POST" })).status, 405);
    const hostStatus = await new Promise((resolve, reject) => {
      http.get(url, { headers: { Host: "unrelated.example" } }, (response) => { response.resume(); resolve(response.statusCode); }).on("error", reject);
    });
    assert.equal(hostStatus, 403);
    assert.equal((await fetch(`${url}/%2e%2e%5cinstallation.json`)).status, 403);
  } finally {
    server.kill();
    await exited;
    await rm(root, { recursive: true, force: true });
  }
});
