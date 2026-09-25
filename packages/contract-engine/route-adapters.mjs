import path from "node:path";
import { normalizeRoute } from "../core/index.mjs";

const METHODS = "GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS";

function lineFor(text, index) {
  return text.slice(0, Math.max(0, index)).split("\n").length;
}

function normalizedPattern(value) {
  return normalizeRoute(String(value ?? "/").replace(/\{[^}]+\}/g, ":param").replace(/\*/g, ":wildcard"));
}

export function routeMatches(pattern, route) {
  const expected = normalizedPattern(pattern).split("/").filter(Boolean);
  const actual = normalizeRoute(route).split("/").filter(Boolean);
  if (expected.length !== actual.length && !String(pattern).includes("*")) return false;
  return expected.every((part, index) => part.startsWith(":") || part === actual[index]);
}

function handler({ adapter, framework, method, route, file, text, index = 0, exportName = null, confidence, parser }) {
  return {
    adapter,
    framework,
    method: String(method).toUpperCase(),
    route: normalizeRoute(route),
    file,
    line: lineFor(text, index),
    index,
    export: exportName,
    confidence,
    parser,
  };
}

function nextHandlers(file, text) {
  const normalized = file.replaceAll(path.sep, "/");
  const match = normalized.match(/(?:^|\/)app\/api\/(.+)\/route\.(?:js|jsx|ts|tsx)$/);
  if (!match) return [];
  const route = `/api/${match[1].replace(/\[\.\.\.([^\]]+)\]/g, ":$1*").replace(/\[([^\]]+)\]/g, ":$1")}`;
  const results = [];
  const pattern = new RegExp(`export\\s+(?:async\\s+)?function\\s+(${METHODS})\\b|export\\s+(?:const|let|var)\\s+(${METHODS})\\s*=`, "gi");
  for (const candidate of text.matchAll(pattern)) {
    const method = candidate[1] ?? candidate[2];
    results.push(handler({ adapter: "next-app-router", framework: "Next.js App Router", method, route, file, text, index: candidate.index, exportName: method.toUpperCase(), confidence: .98, parser: "file-route" }));
  }
  return results;
}

function supabaseHandlers(file, text) {
  const normalized = file.replaceAll(path.sep, "/");
  const match = normalized.match(/(?:^|\/)supabase\/functions\/([^/]+)\/(?:index|main)\.(?:js|ts)$/);
  if (!match || !/(?:Deno\s*\.\s*serve|\bserve)\s*\(/.test(text)) return [];
  const route = `/functions/v1/${match[1]}`;
  const methods = [...text.matchAll(new RegExp(`(?:request|req)\\.method\\s*===?\\s*["'](${METHODS})["']`, "gi"))];
  if (!methods.length) return [handler({ adapter: "supabase-edge", framework: "Supabase Edge Functions", method: "POST", route, file, text, index: text.search(/(?:Deno\s*\.\s*serve|\bserve)\s*\(/), exportName: "serve", confidence: .82, parser: "file-route" })];
  return methods.map((candidate) => handler({ adapter: "supabase-edge", framework: "Supabase Edge Functions", method: candidate[1], route, file, text, index: candidate.index, exportName: "serve", confidence: .9, parser: "method-condition" }));
}

function javascriptRouterFramework(text) {
  if (/(?:from\s*["']hono["']|require\s*\(\s*["']hono["']|new\s+Hono\s*\()/i.test(text)) return { adapter: "hono", framework: "Hono", confidence: .96 };
  if (/(?:from\s*["']fastify["']|require\s*\(\s*["']fastify["']|\bfastify\s*\()/i.test(text)) return { adapter: "fastify", framework: "Fastify", confidence: .96 };
  if (/(?:from\s*["']express["']|require\s*\(\s*["']express["']|\bexpress\s*\()/i.test(text)) return { adapter: "express", framework: "Express", confidence: .96 };
  return { adapter: "javascript-router", framework: "HTTP Router", confidence: .72 };
}

function javascriptRouterHandlers(file, text) {
  if (file.endsWith(".py")) return [];
  const detected = javascriptRouterFramework(text);
  const results = [];
  const chain = new RegExp(`(?:app|router|server|api|fastify)\\.(get|post|put|patch|delete|head|options)\\s*\\(\\s*["'\`]([^"'\`]+)["'\`]`, "gi");
  for (const candidate of text.matchAll(chain)) {
    results.push(handler({ ...detected, method: candidate[1], route: candidate[2], file, text, index: candidate.index, exportName: "route-handler", parser: "call-expression" }));
  }
  if (detected.adapter === "fastify") {
    for (const candidate of text.matchAll(/(?:fastify|app|server)\.route\s*\(\s*\{([\s\S]{0,1200}?)\}\s*\)/gi)) {
      const method = candidate[1].match(new RegExp(`method\\s*:\\s*["'](${METHODS})["']`, "i"))?.[1];
      const route = candidate[1].match(/(?:url|path)\s*:\s*["']([^"']+)["']/i)?.[1];
      if (method && route) results.push(handler({ ...detected, method, route, file, text, index: candidate.index, exportName: "route-handler", parser: "route-object" }));
    }
  }
  return results;
}

function fastApiHandlers(file, text) {
  if (!file.endsWith(".py")) return [];
  return [...text.matchAll(/@(?:app|router)\.(get|post|put|patch|delete|head|options)\s*\(\s*["']([^"']+)["']/gi)].map((candidate) => handler({ adapter: "fastapi", framework: "FastAPI", method: candidate[1], route: candidate[2], file, text, index: candidate.index, exportName: "decorated-handler", confidence: .96, parser: "decorator" }));
}

function nodeHttpHandlers(file, text) {
  const results = [];
  for (const candidate of text.matchAll(/(?:pathname|url\.pathname)\s*===?\s*["'`]([^"'`]+)["'`]/g)) {
    const nearby = text.slice(Math.max(0, candidate.index - 320), candidate.index + 320);
    const method = nearby.match(new RegExp(`(?:request|req)\\.method\\s*===?\\s*["'](${METHODS})["']`, "i"))?.[1] ?? "GET";
    results.push(handler({ adapter: "node-http", framework: "Node HTTP", method, route: candidate[1], file, text, index: candidate.index, exportName: "request-handler", confidence: .8, parser: "route-condition" }));
  }
  return results;
}

const adapters = [nextHandlers, supabaseHandlers, fastApiHandlers, javascriptRouterHandlers, nodeHttpHandlers];

export function discoverRouteHandlers({ file, text }) {
  const discovered = adapters.flatMap((adapter) => adapter(file, text));
  const seen = new Set();
  return discovered.filter((entry) => {
    const key = `${entry.method}:${entry.route}:${entry.line}:${entry.adapter}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function findRouteHandler({ file, text, url, method = "GET" }) {
  const route = new URL(url, "http://aipi.local").pathname;
  const wantedMethod = String(method).toUpperCase();
  return discoverRouteHandlers({ file, text })
    .filter((entry) => entry.method === wantedMethod && routeMatches(entry.route, route))
    .sort((left, right) => right.confidence - left.confidence)[0] ?? null;
}

export const routeAdapterNames = ["next-app-router", "supabase-edge", "express", "fastify", "hono", "fastapi", "node-http"];
