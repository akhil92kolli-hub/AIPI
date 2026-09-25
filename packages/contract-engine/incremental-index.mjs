import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const INDEX_VERSION = 1;

function digest(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}
async function readIndex(file) {
  try {
    const value = JSON.parse(await fs.readFile(file, "utf8"));
    return value.version === INDEX_VERSION && value.files && typeof value.files === "object" ? value : { version: INDEX_VERSION, files: {} };
  } catch (error) {
    if (error.code !== "ENOENT" && error.name !== "SyntaxError") throw error;
    return { version: INDEX_VERSION, files: {} };
  }
}

async function writeIndex(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await fs.rename(temporary, file);
}

/**
 * Incrementally derives source metadata without storing source text. A fast
 * stat signature avoids reading unchanged files; changed files are hashed so
 * timestamp-only updates can still reuse their previous derived result.
 */
export async function incrementalSourceIndex({ root, files, detect, maxBytes = 2_000_000, cacheFile }) {
  const rootPath = path.resolve(root);
  const indexFile = cacheFile ?? path.join(rootPath, ".api-forge", "cache", "source-index-v1.json");
  const previous = await readIndex(indexFile);
  const next = { version: INDEX_VERSION, root: rootPath, generatedAt: new Date().toISOString(), files: {} };
  const results = [];
  const metrics = { discovered: files.length, parsed: 0, cacheHits: 0, contentHits: 0, removed: 0, skippedLarge: 0, unreadable: 0 };

  for (const absoluteFile of files) {
    const relative = path.relative(rootPath, absoluteFile).replaceAll(path.sep, "/");
    try {
      const stats = await fs.stat(absoluteFile);
      const signature = `${stats.size}:${Math.trunc(stats.mtimeMs)}`;
      const cached = previous.files[relative];
      if (cached?.signature === signature && cached.result) {
        next.files[relative] = cached;
        results.push(cached.result);
        metrics.cacheHits += 1;
        continue;
      }
      if (stats.size > maxBytes) {
        metrics.skippedLarge += 1;
        continue;
      }
      const text = await fs.readFile(absoluteFile, "utf8");
      const hash = digest(text);
      if (cached?.hash === hash && cached.result) {
        next.files[relative] = { ...cached, signature };
        results.push(cached.result);
        metrics.contentHits += 1;
        continue;
      }
      const result = await detect(absoluteFile, text);
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
