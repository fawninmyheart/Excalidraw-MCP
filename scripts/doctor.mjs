import assert from "node:assert/strict";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { loadConfig } from "../src/config.mjs";
import { connectCanvas, waitReady } from "../src/cdp.mjs";

const index = process.argv.indexOf("--install-dir");
const config = loadConfig(index >= 0 ? process.argv[index + 1] : undefined);
let cdp, client;
try {
  const health = await (await fetch(`${config.appUrl}__local_health`, { signal: AbortSignal.timeout(5000) })).json();
  assert.equal(path.resolve(health.root), path.resolve(config.buildDir), "A different installation is using the application port");
  cdp = await connectCanvas(config);
  await waitReady(cdp);
  assert(await cdp.evaluate('typeof window.excalidrawLocal.updateElements === "function"'), "Refresh the editor to load incremental editing");
  cdp.close();
  cdp = undefined;
  client = new Client({ name: "Excalidraw-MCP-doctor", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: config.nodePath,
    args: [path.join(config.toolDir, "src", "mcp-server.mjs")],
    env: { ...process.env, EXCALIDRAW_MCP_HOME: config.installDir },
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk) => process.stderr.write(chunk));
  await client.connect(transport);
  const names = (await client.listTools()).tools.map((tool) => tool.name);
  for (const name of ["status", "read_scene", "append_elements", "update_elements", "replace_scene", "export_svg", "screenshot"]) assert(names.includes(name), `Missing MCP tool: ${name}`);
  const result = await client.callTool({ name: "status", arguments: {} });
  assert(!result.isError, JSON.stringify(result.content));
  const status = result.structuredContent ?? JSON.parse(result.content[0].text);
  console.log(JSON.stringify({ ok: true, installDir: config.installDir, appUrl: config.appUrl, mcpName: config.mcpName, tools: names, elementCount: status.elementCount }, null, 2));
} catch (error) {
  console.error(`Excalidraw-MCP check failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  cdp?.close();
  await client?.close();
}
