function balanced(text, start, open = "{", close = "}") {
  let depth = 0;
  let quote = "";
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (character === quote && text[index - 1] !== "\\") quote = "";
      continue;
    }
    if (["'", '"', "`"].includes(character)) { quote = character; continue; }
    if (character === open) depth += 1;
    if (character === close && --depth === 0) return text.slice(start + 1, index);
  }
  return "";
}
function jsType(value = "") {
  if (/\buuid\b/i.test(value)) return "uuid";
  if (/\b(?:integer|int)\b/i.test(value)) return "integer";
  if (/\bnumber\b/i.test(value)) return "number";
  if (/\bboolean\b/i.test(value)) return "boolean";
  if (/\barray\b/i.test(value)) return "array";
  if (/\bobject\b/i.test(value)) return "object";
  if (/\bdate(?:time)?\b/i.test(value)) return "date";
  return "string";
}

function jsonSchemaFields(body) {
  const propertiesMarker = /properties\s*:\s*\{/i.exec(body);
  if (!propertiesMarker) return [];
  const start = propertiesMarker.index + propertiesMarker[0].lastIndexOf("{");
  const properties = balanced(body, start);
  const required = new Set((body.match(/required\s*:\s*\[([^\]]*)\]/i)?.[1] ?? "").match(/[A-Za-z_$][\w$-]*/g) ?? []);
  const fields = [];
  for (const match of properties.matchAll(/([A-Za-z_$][\w$-]*)\s*:\s*\{/g)) {
    const fieldBody = balanced(properties, match.index + match[0].lastIndexOf("{"));
    const type = fieldBody.match(/type\s*:\s*["']([^"']+)["']/i)?.[1] ?? fieldBody;
    const format = fieldBody.match(/format\s*:\s*["']([^"']+)["']/i)?.[1];
    fields.push({ name: match[1], type: format === "uuid" ? "uuid" : jsType(type), required: required.has(match[1]), validator: fieldBody.trim().replace(/\s+/g, " ") });
  }
  return fields;
}

function fastifyValidation(text, handler) {
  if (handler.adapter !== "fastify") return null;
  const start = text.lastIndexOf(".route", handler.index + 20);
  const open = text.indexOf("{", Math.max(0, start));
  if (open < 0) return null;
  const routeObject = balanced(text, open);
  const bodyMarker = /body\s*:\s*\{/i.exec(routeObject);
  if (!bodyMarker) return null;
  const bodyStart = bodyMarker.index + bodyMarker[0].lastIndexOf("{");
  const body = balanced(routeObject, bodyStart);
  const fields = jsonSchemaFields(body);
  return fields.length ? { name: "fastifyRouteBody", kind: "json-schema", fields, additionalProperties: !/additionalProperties\s*:\s*false/i.test(body), source: "fastify-route-schema" } : null;
}

function pydanticType(value = "") {
  const normalized = value.replace(/Optional\[|list\[|List\[|\]/g, " ");
  if (/UUID/i.test(normalized)) return "uuid";
  if (/\bint\b/i.test(normalized)) return "integer";
  if (/\bfloat\b|\bDecimal\b/i.test(normalized)) return "number";
  if (/\bbool\b/i.test(normalized)) return "boolean";
  if (/\blist\b|\bList\b/i.test(value)) return "array";
  if (/datetime|date/i.test(normalized)) return "date";
  return "string";
}

function fastApiValidation(text, handler) {
  if (handler.adapter !== "fastapi") return null;
  const following = text.slice(handler.index);
  const parameters = following.match(/(?:async\s+)?def\s+\w+\s*\(([^)]*)\)/)?.[1] ?? "";
  const modelNames = [...parameters.matchAll(/(?:^|,)\s*\w+\s*:\s*([A-Z][A-Za-z0-9_]*)/g)].map((entry) => entry[1]);
  for (const modelName of modelNames) {
    const pattern = new RegExp(`class\\s+${modelName}\\s*\\([^)]*BaseModel[^)]*\\)\\s*:`);
    const match = pattern.exec(text);
    if (!match) continue;
    const lines = text.slice(match.index + match[0].length).split(/\r?\n/);
    const fields = [];
    for (const line of lines) {
      if (line.trim() && !/^\s+/.test(line)) break;
      const field = line.match(/^\s+([A-Za-z_]\w*)\s*:\s*([^=#]+?)(?:\s*=\s*(.+))?$/);
      if (!field) continue;
      fields.push({ name: field[1], type: pydanticType(field[2]), required: !/Optional\[|\|\s*None/.test(field[2]) && field[3]?.trim() !== "None", validator: field[2].trim() });
    }
    if (fields.length) return { name: modelName, kind: "pydantic", fields, additionalProperties: true, source: "fastapi-body-model" };
  }
  return null;
}

function linkedZodValidation(text, handler, schemas) {
  if (!schemas.length) return null;
  const window = text.slice(handler.index, Math.min(text.length, handler.index + 5000));
  const referenced = schemas.find((schema) => new RegExp(`\\b${schema.name}\\s*\\.\\s*(?:parse|safeParse|parseAsync|safeParseAsync)\\s*\\(`).test(window));
  return referenced ? { ...referenced, source: `${handler.adapter}-handler-reference` } : null;
}

export function validationForHandler({ text, handler, schemas = [], fallback = null }) {
  return fastifyValidation(text, handler)
    ?? fastApiValidation(text, handler)
    ?? linkedZodValidation(text, handler, schemas)
    ?? fallback;
}
