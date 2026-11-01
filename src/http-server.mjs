import http from "node:http";
import { createReadStream, statSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.mjs";

const config = loadConfig();
const root = config.buildDir;
const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
};

if (!statSync(path.join(root, "index.html")).isFile()) {
  throw new Error("Build Excalidraw before starting the local server.");
}

http.createServer((request, response) => {
  if (![ `127.0.0.1:${config.appPort}`, `localhost:${config.appPort}` ].includes(request.headers.host)) {
    response.writeHead(403).end();
    return;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" }).end();
    return;
  }

  try {
    const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    if (pathname === "/__local_health") {
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      response.end(request.method === "HEAD" ? undefined : JSON.stringify({ service: "excalidraw-local", root }));
      return;
    }

    const file = path.resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
    const relative = path.relative(root, file);
    if (relative.startsWith("..") || path.isAbsolute(relative) || pathname.includes("\\")) {
      response.writeHead(403).end();
      return;
    }
    const stat = statSync(file);
    if (!stat.isFile()) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      "Content-Type": mime[path.extname(file).toLowerCase()] || "application/octet-stream",
      "Content-Length": stat.size,
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
    });
    if (request.method === "HEAD") {
      response.end();
    } else {
      const stream = createReadStream(file);
      stream.on("error", () => response.destroy());
      stream.pipe(response);
    }
  } catch (error) {
    response.writeHead(error.code === "ENOENT" || error.code === "ENOTDIR" ? 404 : 400).end();
  }
}).listen(config.appPort, "127.0.0.1", () => {
  console.log(`Excalidraw local: ${config.appUrl}`);
});
