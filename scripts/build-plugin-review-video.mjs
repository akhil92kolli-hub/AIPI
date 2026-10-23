import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const workDir = resolve(root, ".tmp/plugin-review-video");
const frameDir = resolve(workDir, "frames");
const output = resolve(root, "sites/aipi-public/public/review/aipi-plugin-walkthrough.mp4");

mkdirSync(frameDir, { recursive: true });
mkdirSync(resolve(root, "sites/aipi-public/public/review"), { recursive: true });

const escapeXml = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const line = (text, y, options = {}) => {
  const { x = 96, size = 26, color = "#d8dee9", weight = 500, family = "-apple-system, BlinkMacSystemFont, sans-serif", anchor = "start" } = options;
  return `<text x="${x}" y="${y}" fill="${color}" font-family="${family}" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}">${escapeXml(text)}</text>`;
};
const mono = (text, y, options = {}) => line(text, y, { family: "SFMono-Regular, Menlo, monospace", ...options });
const pill = (text, x, y, width, color = "#2dd4bf") => `<rect x="${x}" y="${y}" width="${width}" height="34" rx="7" fill="${color}" fill-opacity=".12" stroke="${color}" stroke-opacity=".55"/><text x="${x + 14}" y="${y + 23}" fill="${color}" font-family="SFMono-Regular, Menlo, monospace" font-size="14" font-weight="700">${escapeXml(text)}</text>`;
const panel = (x, y, width, height, title) => `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="14" fill="#151f2d" stroke="#334155"/><text x="${x + 24}" y="${y + 34}" fill="#94a3b8" font-family="SFMono-Regular, Menlo, monospace" font-size="13" font-weight="700" letter-spacing="1.5">${escapeXml(title)}</text>`;

function shell(kicker, title, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
    <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#080d14"/><stop offset="1" stop-color="#111827"/></linearGradient><pattern id="grid" width="32" height="32" patternUnits="userSpaceOnUse"><path d="M32 0H0V32" fill="none" stroke="#263244" stroke-opacity=".45"/></pattern></defs>
    <rect width="1280" height="720" fill="url(#bg)"/><rect width="1280" height="720" fill="url(#grid)"/>
    <rect x="56" y="48" width="46" height="46" rx="12" fill="#111827" stroke="#334155"/><path d="M68 64h18c8 0 13 4 13 11s-5 11-13 11h-7" fill="none" stroke="#f97316" stroke-width="5" stroke-linecap="round"/><path d="M71 59v30m-5-25 5-5 5 5m-10 20 5 5 5-5" fill="none" stroke="#fff7ed" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><circle cx="88" cy="75" r="4" fill="#fff7ed"/>
    ${line("AIPI", 79, { x: 116, size: 22, color: "#f97316", weight: 850 })}
    ${mono("PLUGIN REVIEW WALKTHROUGH", 79, { x: 181, size: 12, color: "#94a3b8", weight: 700 })}
    ${mono(kicker, 142, { size: 14, color: "#2dd4bf", weight: 700 })}
    ${line(title, 204, { size: 42, color: "#fff7ed", weight: 750 })}
    ${body}
    ${mono("AIPI 0.4.8  •  mcp.aipi.website  •  reviewer walkthrough", 680, { size: 13, color: "#64748b" })}
  </svg>`;
}

const slides = [
  shell("00 / OVERVIEW", "Evidence for every API change", `${line("AIPI gives ChatGPT an organization-scoped view of registered API contracts,", 286, { size: 25 })}${line("immutable history, audit events, and cross-repository blast radius.", 324, { size: 25 })}${panel(96, 382, 1088, 168, "REVIEW SCOPE")}${pill("5 POSITIVE CASES", 126, 426, 192)}${pill("3 NEGATIVE CASES", 338, 426, 192, "#f59e0b")}${pill("OAUTH 2.1", 550, 426, 136, "#60a5fa")}${pill("NO COMMERCE", 706, 426, 164, "#a78bfa")}${line("This recording follows the exact prompts and tools declared in plugin.json.", 520, { x: 126, size: 20, color: "#cbd5e1" })}`),
  shell("01 / CONNECTION", "Secure, account-scoped access", `${panel(96, 270, 480, 270, "CHATGPT")}${line("User prompt", 326, { x: 126, size: 18, color: "#94a3b8", weight: 700 })}${line("AIPI chooses the smallest", 370, { x: 126, size: 24, color: "#fff7ed", weight: 650 })}${line("matching MCP tool.", 406, { x: 126, size: 24, color: "#fff7ed", weight: 650 })}${panel(704, 270, 480, 270, "AIPI MCP")}${pill("OAUTH 2.1 + DCR", 734, 318, 184, "#60a5fa")}${line("Only contracts visible to the", 386, { x: 734, size: 22 })}${line("authenticated organization are returned.", 420, { x: 734, size: 22 })}<path d="M576 405H694" stroke="#f97316" stroke-width="3" stroke-dasharray="8 8"/><path d="m682 394 12 11-12 11" fill="none" stroke="#f97316" stroke-width="3"/>`),
  shell("02 / TEST CASE 1", "List the organization’s contracts", `${panel(96, 270, 1088, 90, "USER PROMPT")}${line("“List the API contracts in my AIPI organization.”", 326, { x: 126, size: 23, color: "#fff7ed", weight: 650 })}${panel(96, 386, 490, 174, "TOOL CALL")}${pill("list_contracts", 126, 430, 168)}${mono('{ "limit": 50 }', 510, { x: 126, size: 18, color: "#cbd5e1" })}${panel(610, 386, 574, 174, "OBSERVABLE RESULT")}${line("12 registered contracts", 442, { x: 640, size: 23, color: "#2dd4bf", weight: 700 })}${mono("GET /patient/launch_patient", 488, { x: 640, size: 17, color: "#fff7ed" })}${mono("POST /api/orders", 522, { x: 640, size: 17, color: "#fff7ed" })}`),
  shell("03 / TEST CASE 2", "Check cross-repository blast radius", `${panel(96, 270, 1088, 90, "USER PROMPT")}${line("“Check the blast radius of this proposed API response schema change.”", 326, { x: 126, size: 22, color: "#fff7ed", weight: 650 })}${panel(96, 386, 490, 190, "TOOL CALL")}${pill("check_blast_radius", 126, 430, 210)}${mono("provider: POST /api/orders", 500, { x: 126, size: 17, color: "#cbd5e1" })}${mono("change: remove order.total", 532, { x: 126, size: 17, color: "#fca5a5" })}${panel(610, 386, 574, 190, "OBSERVABLE RESULT")}${line("2 registered consumers affected", 442, { x: 640, size: 22, color: "#f59e0b", weight: 700 })}${mono("checkout-web  •  CheckoutPanel.tsx:218", 492, { x: 640, size: 16, color: "#fff7ed" })}${mono("billing-worker  •  reconcile.ts:84", 526, { x: 640, size: 16, color: "#fff7ed" })}${mono("Unregistered consumers are not claimed safe.", 558, { x: 640, size: 14, color: "#94a3b8" })}`),
  shell("04 / TEST CASE 3", "Review immutable contract history", `${panel(96, 270, 1088, 90, "USER PROMPT")}${line("“Show the published versions for this API route.”", 326, { x: 126, size: 23, color: "#fff7ed", weight: 650 })}${panel(96, 386, 490, 174, "TOOL CALL")}${pill("list_contract_versions", 126, 430, 246)}${mono("POST /api/orders", 510, { x: 126, size: 18, color: "#cbd5e1" })}${panel(610, 386, 574, 174, "OBSERVABLE RESULT")}${mono("v7  •  sha 8f3a1c  •  verified", 446, { x: 640, size: 18, color: "#2dd4bf" })}${mono("v6  •  sha d91b02  •  superseded", 490, { x: 640, size: 18, color: "#fff7ed" })}${mono("Newest immutable publication first", 532, { x: 640, size: 15, color: "#94a3b8" })}`),
  shell("05 / TEST CASE 4", "Inspect registry audit activity", `${panel(96, 270, 1088, 90, "USER PROMPT")}${line("“Show the latest AIPI contract registry audit events.”", 326, { x: 126, size: 23, color: "#fff7ed", weight: 650 })}${panel(96, 386, 490, 174, "TOOL CALL")}${pill("list_registry_audit", 126, 430, 220)}${mono('{ "limit": 25 }', 510, { x: 126, size: 18, color: "#cbd5e1" })}${panel(610, 386, 574, 174, "OBSERVABLE RESULT")}${mono("15:22  publish_contract  success", 446, { x: 640, size: 17, color: "#2dd4bf" })}${mono("15:18  check_blast_radius  read", 488, { x: 640, size: 17, color: "#fff7ed" })}${mono("Organization-scoped events only", 532, { x: 640, size: 15, color: "#94a3b8" })}`),
  shell("06 / TEST CASE 5", "Register an explicitly reviewed contract", `${panel(96, 270, 1088, 90, "USER PROMPT")}${line("“Register this reviewed API contract and its known consumers in AIPI.”", 326, { x: 126, size: 22, color: "#fff7ed", weight: 650 })}${panel(96, 386, 490, 190, "TOOL CALL")}${pill("register_contract", 126, 430, 194, "#f59e0b")}${mono("PUT /api/orders/:id", 500, { x: 126, size: 17, color: "#cbd5e1" })}${mono("validated payload + consumers", 532, { x: 126, size: 16, color: "#94a3b8" })}${panel(610, 386, 574, 190, "OBSERVABLE RESULT")}${line("Contract registered", 442, { x: 640, size: 23, color: "#2dd4bf", weight: 700 })}${mono("PUT /api/orders/:id", 492, { x: 640, size: 18, color: "#fff7ed" })}${mono("Known consumers: 2  •  audit event recorded", 532, { x: 640, size: 15, color: "#94a3b8" })}`),
  shell("07 / NEGATIVE CASES", "Boundaries remain explicit", `${panel(96, 270, 1088, 282, "EXPECTED SAFE BEHAVIOR")}${pill("NO FALSE SAFETY CLAIMS", 126, 318, 240, "#f59e0b")}${line("Unregistered consumers are unknown—not safe.", 378, { x: 126, size: 21 })}${pill("NO CROSS-ORG ACCESS", 126, 410, 220, "#f59e0b")}${line("AIPI refuses data outside the authenticated account.", 470, { x: 126, size: 21 })}${pill("NO SILENT DELETION", 656, 318, 216, "#f59e0b")}${line("Destructive retention requires explicit confirmation.", 378, { x: 656, size: 21 })}${pill("NO LOCAL SOURCE UPLOAD", 656, 410, 246, "#60a5fa")}${line("Local source and request replay stay in the companion.", 470, { x: 656, size: 21 })}`),
  shell("08 / COMPLETE", "AIPI is ready for reviewer testing", `${panel(96, 278, 1088, 242, "REVIEW SUMMARY")}${pill("5 / 5 POSITIVE", 126, 326, 180)}${pill("3 / 3 NEGATIVE", 326, 326, 180)}${pill("OAUTH VERIFIED", 526, 326, 180, "#60a5fa")}${pill("NO COMMERCE", 726, 326, 164, "#a78bfa")}${line("Remote MCP endpoint", 422, { x: 126, size: 18, color: "#94a3b8", weight: 700 })}${mono("https://mcp.aipi.website/mcp", 458, { x: 126, size: 22, color: "#fff7ed" })}${line("Reviewer credentials are supplied securely in the OpenAI dashboard.", 498, { x: 126, size: 17, color: "#cbd5e1" })}`)
];

for (let index = 0; index < slides.length; index += 1) {
  const name = `slide-${String(index + 1).padStart(2, "0")}`;
  const svgPath = resolve(frameDir, `${name}.svg`);
  writeFileSync(svgPath, slides[index]);
  execFileSync("sips", ["-s", "format", "png", svgPath, "--out", resolve(frameDir, `${name}.png`)], { stdio: "ignore" });
}

for (const file of readdirSync(frameDir)) {
  if (file.endsWith(".png") && !file.startsWith("slide-")) throw new Error(`Unexpected frame: ${file}`);
}

execFileSync("swift", [resolve(root, "scripts/encode-plugin-review-video.swift"), frameDir, output], { stdio: "inherit" });
console.log(output);
