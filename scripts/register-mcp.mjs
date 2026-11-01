import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";
import { parse } from "smol-toml";

const validName = (name) => /^[A-Za-z0-9_-]+$/.test(name);
const plain = (value) => Array.isArray(value) ? value.map(plain)
  : value && typeof value === "object" && !(value instanceof Date)
    ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, plain(entry)])) : value;
const same = (left, right) => isDeepStrictEqual(plain(left), plain(right));
const parseConfig = (text) => {
  try { return parse(text); } catch { throw new Error("Invalid TOML in Codex config; no files changed."); }
};
const withoutEntry = (config, name) => {
  const rest = { ...config, mcp_servers: { ...config.mcp_servers } };
  delete rest.mcp_servers[name];
  if (!Object.keys(rest.mcp_servers).length) delete rest.mcp_servers;
  return rest;
};

// Locate real table headers, ignoring header-looking text inside TOML strings/arrays.
function removeTargetTables(text, name) {
  let quote = "", depth = 0, target = false;
  const markerPath = (object, prefix = []) => {
    for (const [key, value] of Object.entries(object)) {
      if (key === "__registration_marker__") return prefix;
      if (value && typeof value === "object") {
        const found = markerPath(value, [...prefix, key]);
        if (found) return found;
      }
    }
  };
  return text.split(/(?<=\n)/).filter((raw) => {
    const line = raw.replace(/\r?\n$/, "");
    if (!quote && depth === 0 && /^\s*\[/.test(line)) {
      const section = markerPath(parse(`${line}\n__registration_marker__ = true\n`));
      target = section?.[0] === "mcp_servers" && section?.[1] === name;
      return !target;
    }
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (quote) {
        if (quote[0] === '"' && char === "\\") { i++; continue; }
        if (line.startsWith(quote, i)) { i += quote.length - 1; quote = ""; }
      } else if (char === "#") break;
      else if (char === '"' || char === "'") {
        quote = line.startsWith(char.repeat(3), i) ? char.repeat(3) : char;
        i += quote.length - 1;
      } else if (char === "[" || char === "{") depth++;
      else if (char === "]" || char === "}") depth--;
    }
    // Keep standalone comments, including comments introducing the next table.
    return !target || /^\s*(#.*)?$/.test(line);
  }).join("");
}

export function mergeCodexConfig(text, name, entry, replace = false) {
  if (!validName(name)) throw new Error("MCP name must contain only letters, numbers, _ or -.");
  const before = parseConfig(text);
  const existing = before.mcp_servers?.[name];
  if (same(existing, entry)) return text;
  if (existing !== undefined && !replace) {
    throw new Error(`MCP '${name}' already has a different configuration. Choose another --name or explicitly use --replace.`);
  }
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const base = existing === undefined ? text : removeTargetTables(text, name);
  const lines = [`[mcp_servers.${name}]`, `command = ${JSON.stringify(entry.command)}`, `args = ${JSON.stringify(entry.args)}`, "", `[mcp_servers.${name}.env]`];
  for (const [key, value] of Object.entries(entry.env)) lines.push(`${JSON.stringify(key)} = ${JSON.stringify(value)}`);
  const result = base + (base && !base.endsWith("\n") ? newline : "") + (base ? newline : "") + lines.join(newline) + newline;
  const after = parseConfig(result);
  if (!same(after.mcp_servers?.[name], entry) || !same(withoutEntry(before, name), withoutEntry(after, name))) {
    throw new Error("Cannot update this TOML layout without changing other settings; no files changed.");
  }
  return result;
}

function rejectLinks(file) {
  let current = path.resolve(file);
  while (true) {
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error(`Symbolic links are not allowed: ${current}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function atomicWrite(file, contents) {
  rejectLinks(file);
  mkdirSync(path.dirname(file), { recursive: true });
  rejectLinks(file);
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, contents, { encoding: "utf8", flag: "wx" });
    renameSync(temporary, file);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

export function registerMcp({ installDir, name = "excalidraw", skipRegister = false, replace = false, codexConfig } = {}) {
  if (!installDir || !validName(name)) throw new Error("Provide --install-dir and a valid MCP --name.");
  installDir = path.resolve(installDir);
  const installationFile = path.join(installDir, "installation.json");
  rejectLinks(installationFile);
  const installation = JSON.parse(readFileSync(installationFile, "utf8").replace(/^\uFEFF/, ""));
  if (!path.isAbsolute(installation.nodePath ?? "") || !path.isAbsolute(installation.toolDir ?? "")) throw new Error("installation.json must contain absolute nodePath and toolDir values.");
  const entry = { command: installation.nodePath, args: [path.join(installation.toolDir, "src", "mcp-server.mjs")], env: { EXCALIDRAW_MCP_HOME: installDir } };
  const output = path.join(installDir, "mcp-config.json");
  const config = path.resolve(codexConfig ?? path.join(process.env.CODEX_HOME || path.join(homedir(), ".codex"), "config.toml"));
  if ([installationFile, output].includes(config)) throw new Error("Codex config must be separate from installation files.");
  rejectLinks(output);
  let before = "", after = "";
  if (!skipRegister) {
    rejectLinks(config);
    before = existsSync(config) ? readFileSync(config, "utf8") : "";
    after = mergeCodexConfig(before, name, entry, replace);
  }
  const generic = JSON.stringify({ mcpServers: { [name]: entry } }, null, 2) + "\n";
  if (!existsSync(output) || readFileSync(output, "utf8") !== generic) atomicWrite(output, generic);
  let backup;
  if (!skipRegister && before !== after) {
    if ((existsSync(config) ? readFileSync(config, "utf8") : "") !== before) throw new Error("Codex config changed during registration; retry without overwriting it.");
    if (existsSync(config)) {
      backup = path.join(installDir, "logs", `codex-config-${Date.now()}-${randomUUID()}.toml`);
      atomicWrite(backup, before);
    }
    atomicWrite(config, after);
  }
  return { name, registered: !skipRegister, changed: !skipRegister && before !== after, config: skipRegister ? null : config, genericConfig: output, ...(backup ? { backup } : {}) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const options = {};
    const values = { "--install-dir": "installDir", "--name": "name", "--codex-config": "codexConfig" };
    for (let i = 2; i < process.argv.length; i++) {
      const argument = process.argv[i];
      if (argument === "--skip-register") options.skipRegister = true;
      else if (argument === "--replace") options.replace = true;
      else if (values[argument] && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")) options[values[argument]] = process.argv[++i];
      else throw new Error(`Unknown or incomplete argument: ${argument}`);
    }
    console.log(JSON.stringify(registerMcp(options)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
