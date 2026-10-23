import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

// Bump when detector semantics change; cached derived metadata is not valid
// across parser or relationship-rule changes.
export const SOURCE_INDEX_VERSION = 4;

function digest(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}
async function readIndex(file) {
  try {
    const value = JSON.parse(await fs.readFile(file, "utf8"));
    return value.version === SOURCE_INDEX_VERSION && value.files && typeof value.files === "object" ? value : { version: SOURCE_INDEX_VERSION, files: {} };
  } catch (error) {
    if (error.code !== "ENOENT" && error.name !== "SyntaxError") throw error;
    return { version: SOURCE_INDEX_VERSION, files: {} };
  }
}

async function writeIndex(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await fs.rename(temporary, file);
}

/**
 * Incrementally derives source metadata without storing source text. Every
 * candidate is hashed from bytes before a cached result is reused: a file can
 * change while retaining the same size and timestamp.
 */
export async function incrementalSourceIndex({ root, files, detect, maxBytes = 2_000_000, cacheFile }) {
  const rootPath = path.resolve(root);
  const realRoot = await fs.realpath(rootPath);
  const indexFile = cacheFile ?? path.join(rootPath, ".api-forge", "cache", "source-index-v1.json");
  const previous = await readIndex(indexFile);
  const next = { version: SOURCE_INDEX_VERSION, root: rootPath, generatedAt: new Date().toISOString(), files: {} };
  const results = [];
  const metrics = { discovered: files.length, parsed: 0, cacheHits: 0, contentHits: 0, removed: 0, skippedLarge: 0, unreadable: 0 };

  for (const absoluteFile of files) {
    const relative = path.relative(rootPath, absoluteFile).replaceAll(path.sep, "/");
    try {
      if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) {
        metrics.unreadable += 1;
        continue;
      }
      const realFile = await fs.realpath(absoluteFile);
      if (!realFile.startsWith(`${realRoot}${path.sep}`)) {
        metrics.unreadable += 1;
        continue;
      }
      const stats = await fs.stat(absoluteFile);
      const signature = `${stats.size}:${Math.trunc(stats.mtimeMs)}`;
      const cached = previous.files[relative];
      if (stats.size > maxBytes) {
        metrics.skippedLarge += 1;
        continue;
      }
      const bytes = await fs.readFile(absoluteFile);
      if (bytes.length > maxBytes) { metrics.skippedLarge += 1; continue; }
      const hash = digest(bytes);
      if (cached?.hash === hash && cached.result) {
        next.files[relative] = { ...cached, signature };
        results.push(cached.result);
        if (cached.signature === signature) metrics.cacheHits += 1;
        else metrics.contentHits += 1;
        continue;
      }
      const result = await detect(absoluteFile, bytes.toString('utf8'));
      next.files[relative] = { signature, hash, result };
      results.push(result);
      metrics.parsed += 1;
    } catch {
      metrics.unreadable += 1;
    }
  }

  metrics.removed = Object.keys(previous.files).filter((file) => !next.files[file]).length;
  await writeIndex(indexFile, next);
  return { results, metrics, cacheFile: indexFile };
}
