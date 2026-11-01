import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const fixture = fileURLToPath(new URL("./mcp-fixture.mjs", import.meta.url));
const toolNames = ["append_elements", "export_svg", "read_scene", "replace_scene", "screenshot", "status", "update_elements"];
function value(result) {
  assert.notEqual(result.isError, true, JSON.stringify(result.content));
  return result.structuredContent ?? JSON.parse(result.content.find((block) => block.type === "text").text);
}
async function withClient(scenario, mode, run) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [fixture, scenario], stderr: "pipe" });
  let stderr = "";
  transport.stderr.on("data", (chunk) => { stderr += chunk; });
  const client = new Client({ name: "excalidraw-mcp-test", version: "1.0.0" }, { versionNegotiation: { mode } });
  let pid;
  try {
    await client.connect(transport);
    pid = transport.pid;
    await run(client);
  } finally {
    await client.close();
    if (pid) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, `Server child did not exit; stderr: ${stderr}`);
  }
}

for (const mode of ["legacy", "auto"]) {
  test(`real stdio discovery and full tool round trip (${mode})`, { timeout: 30000 }, async () => {
    await withClient("normal", mode, async (client) => {
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map((tool) => tool.name).sort(), toolNames);
      for (const name of ["status", "read_scene", "export_svg", "screenshot"]) {
        assert.equal(tools.find((tool) => tool.name === name).annotations.readOnlyHint, true);
      }
      assert.equal(tools.find((tool) => tool.name === "replace_scene").annotations.destructiveHint, true);
      const call = (name, args = {}) => client.callTool({ name, arguments: args });
      assert.deepEqual(value(await call("status")), { ready: true, url: "http://127.0.0.1:3000/", elementCount: 1 });
      const original = value(await call("read_scene"));
      assert.match(original.revision, /^[a-f0-9]{64}$/);
      assert.equal(original.scene.elements[0].id, "existing");
      const injectionText = '引号 " ; globalThis.injected = true; // <script>not code</script>';
      const added = value(await call("append_elements", {
        elements: [{ type: "text", x: 100, y: 100, text: injectionText }],
      }));
      assert.equal(added.elementCount, 2);
      assert.equal(added.addedIds.length, 1);
      let current = value(await call("read_scene"));
      assert.equal(current.scene.elements[0].id, "existing", "Append must preserve existing elements");
      assert.equal(current.scene.elements[1].text, injectionText, "Quoted JavaScript-like text must remain literal");
      assert.notEqual(current.revision, original.revision);
      assert.equal((await call("replace_scene", { scene: original.scene, expectedRevision: original.revision })).isError, true);
      assert.equal(value(await call("read_scene")).scene.elements.length, 2, "Stale replace must not change the scene");

      const patched = value(await call("update_elements", { updates: [{
        id: current.scene.elements[1].id, expectedVersion: current.scene.elements[1].version,
        changes: { text: "MCP patched label" },
      }] }));
      assert.equal(patched.elementCount, 2);
      current = value(await call("read_scene"));
      assert.equal(current.scene.elements[1].text, "MCP patched label");
      assert.deepEqual(current.scene.elements[0], original.scene.elements[0]);

      current.scene.elements[1].text = "MCP updated label";
      const replaced = value(await call("replace_scene", { scene: current.scene, expectedRevision: current.revision }));
      assert.equal(replaced.elementCount, 2);
      current = value(await call("read_scene"));
      assert.equal(current.scene.elements[1].text, "MCP updated label");
      assert.equal(replaced.revision, current.revision);
      assert.match(value(await call("export_svg")).svg, /MCP updated label/);
      const screenshot = await call("screenshot");
      assert.notEqual(screenshot.isError, true);
      const image = screenshot.content.find((block) => block.type === "image");
      assert.equal(image.mimeType, "image/png");
      assert.equal(Buffer.from(image.data, "base64").subarray(0, 8).toString("hex"), "89504e470d0a1a0a");

      assert.equal((await call("append_elements", { elements: "invalid" })).isError, true);
      assert.equal((await call("replace_scene", { scene: current.scene })).isError, true);
      assert.equal((await call("update_elements", { updates: "invalid" })).isError, true);
      assert.equal((await call("update_elements", { updates: [{ id: "existing", changes: { x: 5 } }] })).isError, true);
      assert.equal(value(await call("read_scene")).revision, current.revision, "Invalid inputs must leave the scene untouched");
      value(await call("replace_scene", { scene: original.scene, expectedRevision: current.revision }));
      assert.deepEqual(value(await call("read_scene")).scene, original.scene);
    });
  });
}

test("concurrent user edit is preserved by the atomic replacement guard", { timeout: 30000 }, async () => {
  await withClient("race", "legacy", async (client) => {
    const original = value(await client.callTool({ name: "read_scene", arguments: {} }));
    const result = await client.callTool({ name: "replace_scene", arguments: {
      scene: { ...original.scene, elements: [] }, expectedRevision: original.revision,
    } });
    assert.equal(result.isError, true);
    const current = value(await client.callTool({ name: "read_scene", arguments: {} }));
    assert.deepEqual(current.scene.elements.map((element) => element.id), ["existing", "external-edit"]);
  });
});

test("element patches allow unrelated additions and preserve untouched versions", { timeout: 30000 }, async () => {
  await withClient("normal", "legacy", async (client) => {
    const call = (name, args = {}) => client.callTool({ name, arguments: args });
    const original = value(await call("read_scene")).scene.elements[0];
    value(await call("append_elements", { elements: [{ type: "text", x: 100, y: 100, text: "User added this" }] }));
    const other = value(await call("read_scene")).scene.elements[1];
    value(await call("update_elements", { updates: [{ id: original.id, expectedVersion: original.version, changes: { x: 99 } }] }));
    const updated = value(await call("read_scene"));
    assert.equal(updated.scene.elements[0].x, 99);
    assert.equal(updated.scene.elements[0].version, original.version + 1);
    assert.deepEqual(updated.scene.elements[1], other, "An unrelated addition and its version must survive the patch");
    assert.equal((await call("update_elements", { updates: [{ id: original.id, expectedVersion: original.version, changes: { x: 88 } }] })).isError, true);
    assert.equal(value(await call("read_scene")).revision, updated.revision, "Old target versions must be rejected without changing data");
    assert.equal((await call("update_elements", { updates: [
      { id: other.id, expectedVersion: other.version, changes: { text: "Must not apply" } },
      { id: original.id, expectedVersion: original.version, changes: { x: 88 } },
    ] })).isError, true);
    assert.equal(value(await call("read_scene")).revision, updated.revision, "A batch conflict must not partially apply");
  });
});

test("same-element concurrent edits reject stale patches and preserve the user change", { timeout: 30000 }, async () => {
  await withClient("element-race", "legacy", async (client) => {
    const original = value(await client.callTool({ name: "read_scene", arguments: {} })).scene.elements[0];
    const result = await client.callTool({ name: "update_elements", arguments: { updates: [{
      id: original.id, expectedVersion: original.version, changes: { x: 99 },
    }] } });
    assert.equal(result.isError, true);
    const current = value(await client.callTool({ name: "read_scene", arguments: {} })).scene.elements[0];
    assert.equal(current.x, 777);
    assert.equal(current.version, original.version + 1);
  });
});

test("discovery works while the canvas is offline; tool failures are reported", { timeout: 30000 }, async () => {
  await withClient("offline", "legacy", async (client) => {
    assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(), toolNames);
    const result = await client.callTool({ name: "read_scene", arguments: {} });
    assert.equal(result.isError, true);
    assert.match(result.content.find((block) => block.type === "text").text, /offline/i);
  });
});
