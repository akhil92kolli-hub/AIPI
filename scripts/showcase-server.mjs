import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../showcase");
const PORT = Number(process.env.AIPI_PORT || 4173);
const mime = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml" };

const server = http.createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
    const target = pathname === "/" ? "index.html" : pathname.replace(/^\//, "");
    const file = path.resolve(ROOT, target);
    if (!file.startsWith(ROOT)) throw new Error("Invalid path");
    const body = await fs.readFile(file);
    response.writeHead(200, { "content-type": mime[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" });
    response.end(body);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
});

server.listen(PORT, "127.0.0.1", () => console.log(`AI-PI showcase: http://127.0.0.1:${PORT}`));
