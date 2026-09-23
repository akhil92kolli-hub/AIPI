import { Node, Project, ScriptTarget, SyntaxKind } from "ts-morph";

function projectFor(file, text) {
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { allowJs: true, checkJs: false, target: ScriptTarget.ES2022 },
  });
  return project.createSourceFile(file, text, { overwrite: true });
}

function normalizedRoute(value) {
  const route = String(value || "/").split("?")[0].replace(/\/+/g, "/");
  return route.startsWith("/") ? route : `/${route}`;
}

function zodType(expression) {
  if (/z\.string\(\)[\s\S]*?\.uuid\(/.test(expression)) return "uuid";
  if (/z\.string\(/.test(expression)) return "string";
  if (/z\.number\(\)[\s\S]*?\.int\(/.test(expression)) return "integer";
  if (/z\.number\(/.test(expression)) return "number";
  if (/z\.boolean\(/.test(expression)) return "boolean";
  if (/z\.array\(/.test(expression)) return "array";
  if (/z\.object\(/.test(expression)) return "object";
  if (/z\.date\(/.test(expression)) return "date";
  return "unknown";
}

function zodSchemas(sourceFile) {
  const schemas = [];
  for (const declaration of sourceFile.getVariableDeclarations()) {
    const initializer = declaration.getInitializer();
    if (!Node.isCallExpression(initializer)) continue;
    const callee = initializer.getExpression();
    if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== "object" || callee.getExpression().getText() !== "z") continue;
    const shape = initializer.getArguments()[0];
    if (!Node.isObjectLiteralExpression(shape)) continue;
    const fields = shape.getProperties().flatMap((property) => {
      if (!Node.isPropertyAssignment(property)) return [];
      const validator = property.getInitializer()?.getText() ?? "";
      return [{
        name: property.getName().replace(/^['"]|['"]$/g, ""),
        type: zodType(validator),
        required: !/\.optional\s*\(/.test(validator),
        validator,
      }];
    });
    schemas.push({ name: declaration.getName(), kind: "zod", fields });
  }
  return schemas;
}

export function astRouteInfo({ file, text, method }) {
  try {
    const sourceFile = projectFor(file, text);
    const handler = sourceFile.getFunctions().find((candidate) => candidate.isExported() && candidate.getName() === String(method).toUpperCase());
    return {
      handler: handler ? { line: handler.getStartLineNumber(), export: String(method).toUpperCase() } : null,
      schemas: zodSchemas(sourceFile),
      parser: "ts-morph",
    };
  } catch {
    return { handler: null, schemas: [], parser: "fallback" };
  }
}

function stringValue(node) {
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) return node.getLiteralValue();
  return null;
}

function property(object, name) {
  return object?.getProperties().find((entry) => Node.isPropertyAssignment(entry) && entry.getName().replace(/^['"]|['"]$/g, "") === name);
}

function normalizedType(node) {
  if (!node) return "unknown";
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) return "string";
  if (Node.isNumericLiteral(node)) return node.getText().includes(".") ? "number" : "integer";
  if (node.getKindName() === "TrueKeyword" || node.getKindName() === "FalseKeyword") return "boolean";
  if (Node.isArrayLiteralExpression(node)) return "array";
  if (Node.isObjectLiteralExpression(node)) return "object";
  const type = node.getType().getText(node);
  if (/\bstring\b/.test(type)) return "string";
  if (/\bnumber\b/.test(type)) return "number";
  if (/\bboolean\b/.test(type)) return "boolean";
  if (/\[\]|Array</.test(type)) return "array";
  return "unknown";
}

export function astFrontendPayload({ file, text, backendRoute, method }) {
  try {
    const sourceFile = projectFor(file, text);
    const calls = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression).flatMap((candidate) => {
      if (!Node.isCallExpression(candidate) || candidate.getExpression().getText() !== "fetch") return [];
      const [urlNode, optionsNode] = candidate.getArguments();
      const route = stringValue(urlNode);
      if (!route) return [];
      const options = Node.isObjectLiteralExpression(optionsNode) ? optionsNode : null;
      const methodProperty = property(options, "method");
      const requestMethod = stringValue(methodProperty?.getInitializer())?.toUpperCase() ?? "GET";
      return [{ candidate, route, method: requestMethod, options }];
    });
    const wantedMethod = String(method ?? "POST").toUpperCase();
    const call = calls.find((entry) => normalizedRoute(entry.route) === normalizedRoute(backendRoute) && entry.method === wantedMethod)
      ?? calls.find((entry) => normalizedRoute(entry.route) === normalizedRoute(backendRoute));
    if (!call) return null;
    const bodyProperty = property(call.options, "body");
    const body = bodyProperty?.getInitializer();
    if (!Node.isCallExpression(body) || body.getExpression().getText() !== "JSON.stringify") return { route: call.route, method: call.method, fields: [], parser: "ts-morph" };
    const payload = body.getArguments()[0];
    if (!Node.isObjectLiteralExpression(payload)) return { route: call.route, method: call.method, fields: [], parser: "ts-morph" };
    const fields = payload.getProperties().flatMap((entry) => {
      if (Node.isShorthandPropertyAssignment(entry)) {
        const expression = entry.getNameNode();
        return [{ name: entry.getName(), type: normalizedType(expression), expression: expression.getText() }];
      }
      if (Node.isPropertyAssignment(entry)) {
        const expression = entry.getInitializer();
        return [{ name: entry.getName().replace(/^['"]|['"]$/g, ""), type: normalizedType(expression), expression: expression?.getText() ?? "" }];
      }
      return [];
    });
    return { route: call.route, method: call.method, fields, parser: "ts-morph" };
  } catch {
    return null;
  }
}
