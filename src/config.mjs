import { readFileSync } from "node:fs";
import path from "node:path";

export function loadConfig(installDir = process.env.EXCALIDRAW_MCP_HOME) {
  if (!installDir) {
    if (!process.env.LOCALAPPDATA) throw new Error("Set EXCALIDRAW_MCP_HOME to your installation directory.");
    installDir = path.join(process.env.LOCALAPPDATA, "Excalidraw-MCP");
  }
  const filename = path.resolve(installDir, "installation.json");
  let config;
  try { config = JSON.parse(readFileSync(filename, "utf8").replace(/^\uFEFF/, "")); }
  catch (error) { throw new Error(`Run install.ps1 first. Cannot read ${filename}: ${error.message}`); }
  for (const key of ["appPort", "cdpPort"]) {
    if (!Number.isInteger(config[key]) || config[key] < 1024 || config[key] > 65535) throw new Error(`Invalid ${key} in installation.json`);
  }
  if (config.appPort === config.cdpPort) throw new Error("Application and CDP ports must differ.");
  for (const key of ["installDir", "toolDir", "buildDir", "nodePath", "browserPath", "profileDir"]) {
    if (typeof config[key] !== "string" || !path.isAbsolute(config[key])) throw new Error(`Invalid absolute path: ${key}`);
  }
  return { ...config, appUrl: `http://127.0.0.1:${config.appPort}/`, cdpUrl: `http://127.0.0.1:${config.cdpPort}` };
}
