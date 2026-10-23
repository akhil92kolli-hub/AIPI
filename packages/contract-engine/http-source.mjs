import { Node, Project, ScriptTarget, SyntaxKind } from "ts-morph";

function sourceFile(file, text) {
  return new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true,
    compilerOptions: { allowJs: true, noLib: true, target: ScriptTarget.ES2022 } })
    .createSourceFile(file, text);
}
const literal = node => node && (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) ? node.getLiteralText() : null;
const declaration = node => node?.getSymbol()?.getDeclarations()?.[0];
const same = (a, b) => Boolean(a && b && declaration(a) === b);
const isFunction = node => Node.isFunctionDeclaration(node) || Node.isArrowFunction(node) || Node.isFunctionExpression(node) || Node.isMethodDeclaration(node);
const enclosingFunction = node => node.getFirstAncestor(isFunction);
const property = (node, name) => Node.isPropertyAccessExpression(node) && node.getName() === name;
function atoms(node) {
  if (Node.isParenthesizedExpression(node)) return atoms(node.getExpression());
  if (Node.isBinaryExpression(node) && node.getOperatorToken().getKind() === SyntaxKind.AmpersandAmpersandToken)
    return [...atoms(node.getLeft()), ...atoms(node.getRight())];
  return [node];
}
function equals(node) {
  return Node.isBinaryExpression(node) && [SyntaxKind.EqualsEqualsToken, SyntaxKind.EqualsEqualsEqualsToken].includes(node.getOperatorToken().getKind())
    ? [node.getLeft(), node.getRight()] : [];
}

// Only anchored segment patterns are supported. Optional groups, wildcards and
// arbitrary expressions stay unresolved rather than becoming invented routes.
function regexRoute(node) {
  if (!node || node.getKind() !== SyntaxKind.RegularExpressionLiteral) return null;
  const raw = node.getText();
  if (!raw.startsWith('/^') || !raw.endsWith('$/')) return null;
  const route = raw.slice(2, -2).replaceAll('\\/', '/').replaceAll('([^/]+)', ':param');
  return /^\/[\w/:.\-]*$/.test(route) ? route : null;
}

export function nodeHttpRoutes(file, text) {
  if (!/\.[cm]?[jt]sx?$/.test(file) || !/createServer\s*\(/.test(text)) return [];
  const source = sourceFile(file, text), results = [];
  const serverImports = new Set();
  for (const entry of source.getImportDeclarations()) {
    if (!['http', 'https', 'node:http', 'node:https'].includes(entry.getModuleSpecifierValue())) continue;
    for (const binding of [entry.getDefaultImport(), entry.getNamespaceImport(), ...entry.getNamedImports().filter(n => n.getName() === 'createServer').map(n => n.getAliasNode() ?? n.getNameNode())].filter(Boolean)) serverImports.add(declaration(binding));
  }
  for (const call of source.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression();
    const binding = Node.isPropertyAccessExpression(callee) && callee.getName() === 'createServer' ? callee.getExpression() : Node.isIdentifier(callee) && callee.getText() === 'createServer' ? callee : null;
    if (!binding || !serverImports.has(declaration(binding))) continue;
    const callback = call.getArguments().find(n => Node.isArrowFunction(n) || Node.isFunctionExpression(n));
    const request = callback?.getParameters()[0];
    if (!request) continue;
    const isPathname = node => {
      if (!property(node, 'pathname')) return false;
      const receiver = node.getExpression(), def = declaration(receiver);
      const init = Node.isNewExpression(receiver) ? receiver : def && Node.isVariableDeclaration(def) ? def.getInitializer() : null;
      if (!init || !Node.isNewExpression(init) || init.getExpression().getText() !== 'URL') return false;
      const input = init.getArguments()[0];
      return input && property(input, 'url') && same(input.getExpression(), request);
    };
    for (const condition of callback.getDescendantsOfKind(SyntaxKind.IfStatement)) {
      if (enclosingFunction(condition) !== callback) continue;
      const parts = atoms(condition.getExpression());
      let method, route;
      for (const part of parts) {
        const [left, right] = equals(part);
        if (left && property(left, 'method') && same(left.getExpression(), request) && /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(literal(right) ?? '')) method = literal(right);
        if (left && isPathname(left)) route = literal(right);
        if (Node.isIdentifier(part)) {
          const def = declaration(part), init = def && Node.isVariableDeclaration(def) ? def.getInitializer() : null;
          if (init && Node.isCallExpression(init) && property(init.getExpression(), 'match') && isPathname(init.getExpression().getExpression())) route = regexRoute(init.getArguments()[0]);
        }
      }
      if (method && route?.startsWith('/')) results.push({ method, route, index: condition.getStart(),
        endLine: condition.getEndLineNumber(), rangeMethod: 'typescript-ast', confidence: .95, parser: 'ast-route-condition' });
    }
  }
  return results;
}

function callable(node) {
  const def = declaration(node);
  if (!def) return null;
  if (Node.isFunctionDeclaration(def)) return def;
  if (Node.isVariableDeclaration(def)) {
    const init = def.getInitializer();
    if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) return init;
  }
  return null;
}
function methodFromOptions(node) {
  if (!node) return 'GET';
  if (!Node.isObjectLiteralExpression(node)) return null;
  let method = 'GET';
  for (const entry of node.getProperties()) {
    if (Node.isSpreadAssignment(entry)) method = null;
    else if (Node.isPropertyAssignment(entry) && entry.getName() === 'method') method = literal(entry.getInitializer());
  }
  return /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(method ?? '') ? method : null;
}

function templateRoute(node) {
  let route = node.getHead().getLiteralText();
  for (const span of node.getTemplateSpans()) {
    if (route.includes('?') || route.includes('#')) break;
    const expression = span.getExpression(), tail = span.getLiteral().getLiteralText();
    // Only an encoded whole path segment may stand for a route parameter.
    if (!route.endsWith('/') || !/^(?:[/?#]|$)/.test(tail) || !Node.isCallExpression(expression) ||
      expression.getExpression().getText() !== 'encodeURIComponent' || declaration(expression.getExpression())) return null;
    route += ':param' + tail;
  }
  route = route.split(/[?#]/)[0];
  return route.startsWith('/') && !route.startsWith('//') ? route : null;
}

export function httpCalls(file, text) {
  if (!/\.[cm]?[jt]sx?$/.test(file) || !/\bfetch\s*\(/.test(text)) return [];
  const source = sourceFile(file, text), cache = new Map();
  const isFetch = node => Node.isIdentifier(node) && node.getText() === 'fetch' && !declaration(node);
  const transport = (fn, visiting = new Set()) => {
    if (cache.has(fn)) return cache.get(fn);
    if (visiting.has(fn)) return null;
    visiting.add(fn);
    const [urlParam, optionsParam] = fn.getParameters();
    if (!urlParam || !optionsParam) return null;
    const matches = [];
    for (const call of fn.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      if (enclosingFunction(call) !== fn) continue;
      const callee = call.getExpression(), nested = callable(callee);
      const downstream = isFetch(callee) ? { chain: ['fetch'] } : nested ? transport(nested, new Set(visiting)) : null;
      if (!downstream) continue;
      const [url, options] = call.getArguments();
      // Wrappers must forward both URL and options. A prefix is recorded as
      // unresolved origin, so this yields a candidate link, never runtime proof.
      const directUrl = same(url, urlParam);
      const prefixedUrl = url && Node.isTemplateExpression(url) && url.getTemplateSpans().at(-1)?.getLiteral().getLiteralText() === '' && same(url.getTemplateSpans().at(-1)?.getExpression(), urlParam);
      const lastOption = options && Node.isObjectLiteralExpression(options) ? options.getProperties().at(-1) : null;
      const forwardedOptions = same(options, optionsParam) || lastOption && Node.isSpreadAssignment(lastOption) && same(lastOption.getExpression(), optionsParam);
      if ((directUrl || prefixedUrl) && forwardedOptions) matches.push({ chain: [fn.getSymbol()?.getName() ?? 'wrapper', ...downstream.chain], unresolvedOrigin: Boolean(prefixedUrl || downstream.unresolvedOrigin) });
    }
    const result = matches.length === 1 ? matches[0] : null;
    cache.set(fn, result);
    return result;
  };
  const calls = [];
  for (const call of source.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression(), fn = callable(callee);
    const info = isFetch(callee) ? { chain: ['fetch'] } : fn ? transport(fn) : null;
    if (!info) continue;
    const [url, options] = call.getArguments(), method = methodFromOptions(options);
    if (!url || !method) continue;
    const value = literal(url);
    const dynamic = value === null && Node.isTemplateExpression(url);
    if (value === null && !dynamic) continue;
    const route = dynamic ? url.getText().slice(1, -1) : value;
    const routePattern = dynamic ? templateRoute(url) : null;
    calls.push({ method, path: route, line: call.getStartLineNumber(), endLine: call.getEndLineNumber(),
      rangeMethod: 'typescript-ast', client: info.chain.join(' → '),
      confidence: dynamic ? routePattern ? .65 : .45 : info.unresolvedOrigin ? .7 : .9,
      resolution: dynamic ? routePattern ? 'parameterized-template' : 'dynamic-template' : info.unresolvedOrigin ? 'wrapper-origin-unresolved' : 'literal',
      routePattern,
      detectionMethod: 'ast-http-call', wrapperSource: fn ? { source: file, line: fn.getStartLineNumber() } : null });
  }
  return calls;
}
