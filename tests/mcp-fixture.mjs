import vm from "node:vm";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createServer } from "../src/mcp-server.mjs";

// This child has no browser connection: all tool expressions run in this VM.
const scenario = process.argv[2];
let scene = {
  type: "excalidraw", version: 2, source: "test-fixture",
  elements: [{ id: "existing", type: "rectangle", x: 10, y: 20, width: 80, height: 40, version: 1 }],
  appState: { viewBackgroundColor: "#ffffff" }, files: {},
};
let nextId = 0;
const copy = (value) => JSON.parse(JSON.stringify(value));
const escape = (text) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
const context = vm.createContext({ window: { excalidrawLocal: {
  isReady: () => true,
  getScene: () => copy(scene),
  async append(elements) {
    scene.elements.push(...elements.map((element) => ({ ...copy(element), id: `added-${++nextId}`, version: 1 })));
    return copy(scene);
  },
  async updateElements(updates) {
    for (const update of updates) {
      const element = scene.elements.find((item) => item.id === update.id);
      if (!element || element.version !== update.expectedVersion) throw new Error("Element version conflict");
    }
    const byId = new Map(updates.map((update) => [update.id, update]));
    scene.elements = scene.elements.map((element) => byId.has(element.id)
      ? { ...element, ...copy(byId.get(element.id).changes), version: element.version + 1 }
      : element);
    return copy(scene);
  },
  async replace(replacement) { scene = copy(replacement); return copy(scene); },
  async exportSVG() {
    return `<svg xmlns="http://www.w3.org/2000/svg"><text>${escape(scene.elements.map((el) => el.text || "").join(" "))}</text></svg>`;
  },
} } });
let raced = false;
async function mockConnect() {
  if (scenario === "offline") throw new Error("Test canvas is offline");
  return {
    url: "http://127.0.0.1:3000/",
    async evaluate(expression) {
      if (scenario === "race" && !raced && expression.includes(".replace(")) {
        raced = true;
        scene.elements.push({ id: "external-edit", type: "text", text: "Concurrent user edit", x: 0, y: 0 });
      }
      if (scenario === "element-race" && !raced && expression.includes(".updateElements(")) {
        raced = true;
        scene.elements[0] = { ...scene.elements[0], x: 777, version: scene.elements[0].version + 1 };
      }
      const result = await vm.runInContext(expression, context, { timeout: 1000 });
      if (context.injected !== undefined) throw new Error("Unescaped input executed JavaScript");
      return copy(result);
    },
    async call(method) {
      if (method !== "Page.captureScreenshot") throw new Error(`Unexpected CDP call: ${method}`);
      return { data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" };
    },
    close() {},
  };
}
await serveStdio(() => createServer(mockConnect));
