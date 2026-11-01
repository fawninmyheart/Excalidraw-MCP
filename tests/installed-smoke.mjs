import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../src/config.mjs";
import { setTimeout as delay } from "node:timers/promises";
import { connectCanvas, waitReady } from "../src/cdp.mjs";

const installIndex = process.argv.indexOf("--install-dir");
const config = loadConfig(installIndex >= 0 ? process.argv[installIndex + 1] : undefined);
const logs = path.join(config.installDir, "logs") + path.sep;
await mkdir(logs, { recursive: true });
const report = { startedAt: new Date().toISOString(), checks: [], restored: false };
const saveJSON = (name, data) => writeFile(`${logs}${name}`, `${JSON.stringify(data, null, 2)}\n`);
let client, original, windowId, originalBounds;
let changed = false;
const ready = () => waitReady(client);
const read = () => client.evaluate("window.excalidrawLocal.getScene()");
const replace = (scene) => client.evaluate(`window.excalidrawLocal.replace(${JSON.stringify(scene)})`);
const append = (elements) => client.evaluate(`window.excalidrawLocal.append(${JSON.stringify(elements)})`);
async function reload() {
  const previous = await client.evaluate("performance.timeOrigin");
  await client.call("Page.reload", { ignoreCache: true });
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    await delay(100);
    try {
      if (await client.evaluate(`performance.timeOrigin !== ${previous} && window.excalidrawLocal?.isReady()`)) return;
    } catch { /* The old JavaScript context is discarded during navigation. */ }
  }
  throw new Error("Canvas did not finish reloading");
}
const hasText = (scene, text) => scene.elements.some((element) => element.type === "text" && element.text === text);
async function restoreWindow() {
  if (windowId === undefined) return;
  await client.call("Browser.setWindowBounds", { windowId, bounds: { windowState: originalBounds.windowState } });
  if (originalBounds.windowState === "normal") {
    await client.call("Browser.setWindowBounds", { windowId, bounds: originalBounds });
  }
}

try {
  client = await connectCanvas(config);
  await ready();
  original = await read();
  await saveJSON("smoke-original.excalidraw", original);
  assert.equal(original.elements.length, 0, "Refusing to test a nonempty canvas");
  const { targetInfo } = await client.call("Target.getTargetInfo");
  ({ windowId, bounds: originalBounds } = await client.call("Browser.getWindowForTarget", { targetId: targetInfo.targetId }));

  changed = true;
  await append([
    { type: "rectangle", x: 100, y: 100, width: 240, height: 100, label: { text: "Codex local smoke" } },
    { type: "arrow", x: 370, y: 150, width: 180, height: 0, points: [[0, 0], [180, 0]], label: { text: "API" } },
  ]);
  let scene = await read();
  assert(scene.elements.some((element) => element.type === "rectangle"));
  assert(scene.elements.some((element) => element.type === "arrow"));
  assert(hasText(scene, "Codex local smoke"));
  report.checks.push("append rectangle, arrow, and bound labels; read scene");

  const label = scene.elements.find((element) => element.type === "text" && element.text === "Codex local smoke");
  label.text = label.originalText = "Codex updated label";
  await replace(scene);
  assert(hasText(await read(), "Codex updated label"));
  const svg = await client.evaluate("window.excalidrawLocal.exportSVG()");
  assert(svg.includes("Codex updated label"), "SVG must contain the modified label");
  await writeFile(`${logs}smoke.svg`, svg);
  report.checks.push("replace text and export SVG");

  scene = await read();
  const fileId = "codex-smoke-pixel";
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  assert.equal(await client.evaluate(`(async () => {
    const image = new Image(); image.src = ${JSON.stringify(png)}; await image.decode(); return image.naturalWidth;
  })()`), 1, "The image fixture must decode as a one-pixel PNG");
  scene.elements.push({
    ...scene.elements.find((element) => element.type === "rectangle"),
    id: "codex-smoke-image", type: "image", x: 100, y: 280, width: 32, height: 32,
    fileId, scale: [1, 1], status: "saved", crop: null, boundElements: null, roundness: null,
  });
  scene.files[fileId] = { id: fileId, dataURL: png, mimeType: "image/png", created: Date.now(), lastRetrieved: Date.now() };
  await replace(scene);
  await reload();
  await ready();
  scene = await read();
  assert.equal(scene.files[fileId]?.dataURL, png, "Image data must survive reload");
  assert(scene.elements.some((element) => element.type === "image" && element.fileId === fileId && element.status !== "error"));
  report.checks.push("image element and PNG bytes persist across reload");

  await client.call("Browser.setWindowBounds", { windowId, bounds: { windowState: "minimized" } });
  // Edge can report a stale "normal" windowState; test the real page visibility.
  for (let i = 0; i < 50 && !await client.evaluate("document.hidden"); i++) await delay(100);
  assert.equal(await client.evaluate("document.hidden"), true, "Canvas must be genuinely hidden");
  await append([{ type: "text", x: 100, y: 350, text: "Background persistence verified" }]);
  assert.equal(await client.evaluate("document.hidden"), true, "Canvas must remain hidden during background write");
  await reload();
  await ready();
  assert.equal(await client.evaluate("document.hidden"), true, "Reload must not bring the canvas to the foreground");
  scene = await read();
  assert(hasText(scene, "Background persistence verified"));
  assert(hasText(scene, "Codex updated label"));
  assert.equal(scene.files[fileId]?.dataURL, png);
  await saveJSON("smoke-verified.excalidraw", scene);
  report.checks.push("minimized background append persists after hidden reload, retaining labels and image");
  await restoreWindow();
  const screenshot = await client.call("Page.captureScreenshot", { format: "png" });
  await writeFile(`${logs}smoke-verified.png`, Buffer.from(screenshot.data, "base64"));
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error.stack || String(error);
  process.exitCode = 1;
} finally {
  if (changed && original && client) {
    try {
      await ready();
      await replace(original);
      await reload();
      await ready();
      const restored = await read();
      assert.deepEqual(restored.elements, original.elements, "Original elements must be restored");
      assert.deepEqual(restored.files, original.files, "Original file references must be restored");
      report.restored = true;
      await saveJSON("smoke-restored.excalidraw", restored);
    } catch (error) {
      report.restoreError = error.stack || String(error);
      report.passed = false;
      process.exitCode = 1;
    }
  }
  try { await restoreWindow(); } catch (error) {
    report.windowRestoreError = String(error);
    report.passed = false;
    process.exitCode = 1;
  }
  await client?.close();
  report.finishedAt = new Date().toISOString();
  await saveJSON("smoke-report.json", report);
  console.log(JSON.stringify(report, null, 2));
}
