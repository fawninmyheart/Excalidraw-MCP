import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parse } from "smol-toml";
import { mergeCodexConfig, registerMcp } from "../scripts/register-mcp.mjs";

const sampleEntry = {
  command: "C:\\安装 目录\\node.exe",
  args: ["C:\\安装 目录\\tool\\src\\mcp-server.mjs"],
  env: { EXCALIDRAW_MCP_HOME: "C:\\安装 目录" },
};

function fixture(t, initial = 'model = "existing-model"\n') {
  const root = mkdtempSync(path.join(tmpdir(), "excalidraw-register-"));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    assert(path.basename(root).startsWith("excalidraw-register-"));
    rmSync(root, { recursive: true, force: true });
  });
  const installDir = path.join(root, "安装 目录");
  const codexConfig = path.join(root, "isolated-codex", "config.toml");
  mkdirSync(installDir, { recursive: true });
  mkdirSync(path.dirname(codexConfig), { recursive: true });
  writeFileSync(path.join(installDir, "installation.json"), JSON.stringify({
    nodePath: path.join(installDir, "node.exe"), toolDir: path.join(installDir, "tool"),
  }));
  writeFileSync(codexConfig, initial);
  return { root, installDir, codexConfig };
}

test("append preserves existing TOML bytes and supports Unicode/space paths", () => {
  const before = '# keep this comment\r\nmodel = "unchanged"\r\n\r\n[mcp_servers.other]\r\ncommand = "other"\r\nargs = ["a b"]\r\n';
  const after = mergeCodexConfig(before, "excalidraw", sampleEntry);
  assert(after.startsWith(before));
  assert.equal(after.replaceAll("\r\n", "").includes("\n"), false, "Preserve CRLF style");
  assert.deepEqual(JSON.parse(JSON.stringify(parse(after).mcp_servers.excalidraw)), sampleEntry);
  assert.deepEqual(parse(after).mcp_servers.other, parse(before).mcp_servers.other);
});

test("replace handles separated main/env tables without touching other sections or comments", () => {
  const otherStart = '[profiles.work]\nnote = """\n[mcp_servers.excalidraw]\nlooks = "like a table"\n"""\n';
  const otherMiddle = '# keep the feature comment\n[features]\nfeature = true\n';
  const otherEnd = '# keep the other server comment\n[mcp_servers.other]\ncommand = "other"\n';
  const before = otherStart + '[mcp_servers.excalidraw]\ncommand = "old"\nargs = [\n  "old-script",\n]\n' + otherMiddle + '[mcp_servers."excalidraw".env]\nOLD = "value"\n' + otherEnd;
  assert.throws(() => mergeCodexConfig(before, "excalidraw", sampleEntry), /--replace/);
  const after = mergeCodexConfig(before, "excalidraw", sampleEntry, true);
  assert(after.includes(otherStart));
  assert(after.includes(otherMiddle));
  assert(after.includes(otherEnd));
  assert(!after.includes('command = "old"'));
  assert(!after.includes('OLD = "value"'));
  assert.deepEqual(JSON.parse(JSON.stringify(parse(after).mcp_servers.excalidraw)), sampleEntry);
  assert.deepEqual(parse(after).profiles, parse(before).profiles);
});

test("registration writes generated config and backup, then is byte-for-byte idempotent", (t) => {
  const options = fixture(t);
  const original = readFileSync(options.codexConfig, "utf8");
  const first = registerMcp(options);
  assert.equal(first.changed, true);
  assert.equal(readFileSync(first.backup, "utf8"), original);
  assert.equal(path.dirname(first.backup), path.join(options.installDir, "logs"));
  const generic = JSON.parse(readFileSync(first.genericConfig, "utf8"));
  assert.equal(generic.mcpServers.excalidraw.env.EXCALIDRAW_MCP_HOME, options.installDir);
  assert.equal(generic.mcpServers.excalidraw.args[0], path.join(options.installDir, "tool", "src", "mcp-server.mjs"));
  const after = readFileSync(options.codexConfig, "utf8");
  const modified = statSync(options.codexConfig).mtimeMs;
  const second = registerMcp(options);
  assert.equal(second.changed, false);
  assert.equal(second.backup, undefined);
  assert.equal(readFileSync(options.codexConfig, "utf8"), after);
  assert.equal(statSync(options.codexConfig).mtimeMs, modified);
  assert.equal(readdirSync(path.join(options.installDir, "logs")).length, 1);
});

test("existing different entry is untouched unless replacement is explicit", (t) => {
  const unrelated = '# keep\nmodel = "unchanged"\n[mcp_servers.other]\ncommand = "other"\n';
  const original = unrelated + '[mcp_servers.excalidraw]\ncommand = "old"\nargs = []\n';
  const options = fixture(t, original);
  assert.throws(() => registerMcp(options), /another --name.*--replace/);
  assert.equal(readFileSync(options.codexConfig, "utf8"), original);
  assert(!existsSync(path.join(options.installDir, "mcp-config.json")));
  const result = registerMcp({ ...options, replace: true });
  assert.equal(result.changed, true);
  assert(readFileSync(options.codexConfig, "utf8").startsWith(unrelated));
  assert.equal(readFileSync(result.backup, "utf8"), original);
});

test("invalid TOML is rejected before writing any output", (t) => {
  const options = fixture(t, '[broken\nsecret = "do-not-print"\n');
  assert.throws(() => registerMcp(options), /^Error: Invalid TOML in Codex config; no files changed\.$/);
  assert.equal(readFileSync(options.codexConfig, "utf8"), '[broken\nsecret = "do-not-print"\n');
  assert(!existsSync(path.join(options.installDir, "mcp-config.json")));
  assert(!existsSync(path.join(options.installDir, "logs")));
});

test("skip-register generates portable config without reading or modifying Codex config", (t) => {
  const options = fixture(t, "not valid TOML");
  const result = registerMcp({ ...options, skipRegister: true, name: "excalidraw-local" });
  assert.equal(result.registered, false);
  assert.equal(result.changed, false);
  assert.equal(result.config, null);
  assert.equal(readFileSync(options.codexConfig, "utf8"), "not valid TOML");
  assert(JSON.parse(readFileSync(result.genericConfig, "utf8")).mcpServers["excalidraw-local"]);
});

test("invalid server names cannot alter TOML table structure", () => {
  for (const name of ["", "excalidraw.env", "bad\nname", "quoted\"name"]) {
    assert.throws(() => mergeCodexConfig("", name, sampleEntry), /MCP name/);
  }
});

test("registration refuses a linked config parent directory", (t) => {
  const options = fixture(t);
  const link = path.join(options.root, "linked-codex");
  try { symlinkSync(path.dirname(options.codexConfig), link, process.platform === "win32" ? "junction" : "dir"); }
  catch (error) { if (error.code === "EPERM") { t.skip("Symlink creation unavailable"); return; } throw error; }
  assert.throws(() => registerMcp({ ...options, codexConfig: path.join(link, "config.toml") }), /Symbolic links/);
  assert.equal(readFileSync(options.codexConfig, "utf8"), 'model = "existing-model"\n');
  assert(!existsSync(path.join(options.installDir, "mcp-config.json")));
});
