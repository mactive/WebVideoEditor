import { spawnSync } from "node:child_process";
import { Console } from "node:console";
import { createServer, request } from "node:http";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
import { fileURLToPath, URL } from "node:url";

import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const docsRoot = join(root, "apps/docs");
const distRoot = join(docsRoot, ".vitepress/dist");
const checkDist = process.argv.includes("--dist");
const output = new Console({
  stderr: process.stderr,
  stdout: process.stdout,
});
const docsRequire = createRequire(join(docsRoot, "package.json"));
const { JSDOM } = await import(docsRequire.resolve("jsdom"));
const dom = new JSDOM("<!doctype html><html><body></body></html>");
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: dom.window.navigator,
});
const { default: mermaid } = await import(docsRequire.resolve("mermaid"));
const rootPackage = JSON.parse(
  readFileSync(join(root, "package.json"), "utf8"),
);
const workspacePackages = new Map();
const errors = [];
const sourceRoutes = new Set();
const documentedEvents = new Set();
let checkedLinks = 0;
let checkedCommands = 0;
let checkedDiagrams = 0;

function filesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (
      entry.name === ".vitepress" ||
      entry.name === "node_modules" ||
      entry.name === "public"
    ) {
      return [];
    }
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

function generateSources() {
  const result = spawnSync(
    process.execPath,
    [join(root, "scripts/generate-doc-sources.mjs")],
    {
      cwd: root,
      encoding: "utf8",
    },
  );
  if (result.status !== 0) {
    errors.push(`静态源码生成失败: ${(result.stderr || result.stdout).trim()}`);
  } else if (result.stdout.trim()) {
    output.log(result.stdout.trim());
  }
}

if (!checkDist) {
  generateSources();
}

for (const packageFile of filesUnder(join(root, "apps"))
  .concat(filesUnder(join(root, "packages")))
  .filter((path) => path.endsWith("package.json"))) {
  const manifest = JSON.parse(readFileSync(packageFile, "utf8"));
  workspacePackages.set(manifest.name, manifest);
}

function sourceRoutePaths(href) {
  const route = decodeURI(href.split("#", 1)[0].split("?", 1)[0]);
  if (!route.startsWith("/source/") || !route.endsWith(".txt")) {
    return undefined;
  }
  const sourceRelative = route.slice("/source/".length, -".txt".length);
  const sourcePath = resolve(root, sourceRelative);
  const fromRoot = relative(root, sourcePath);
  if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) {
    return undefined;
  }
  return {
    generatedPath: join(docsRoot, "public", route.slice(1)),
    route,
    sourcePath,
  };
}

function localTarget(markdownPath, href) {
  const withoutAnchor = decodeURI(href.split("#", 1)[0].split("?", 1)[0]);
  if (!withoutAnchor) {
    return undefined;
  }
  const source = sourceRoutePaths(href);
  if (source) {
    return source.generatedPath;
  }
  if (withoutAnchor.startsWith("/")) {
    const route = join(docsRoot, withoutAnchor);
    return extname(route)
      ? route
      : existsSync(`${route}.md`)
        ? `${route}.md`
        : join(route, "index.md");
  }
  return resolve(dirname(markdownPath), withoutAnchor);
}

function validateSourceLink(markdownPath, href) {
  const paths = sourceRoutePaths(href);
  if (!paths) {
    errors.push(`${relative(root, markdownPath)}: 非法静态源码链接: ${href}`);
    return;
  }
  sourceRoutes.add(paths.route);
  if (!existsSync(paths.sourcePath) || !statSync(paths.sourcePath).isFile()) {
    errors.push(`${relative(root, markdownPath)}: 工作区源码不存在: ${href}`);
    return;
  }
  if (
    !existsSync(paths.generatedPath) ||
    readFileSync(paths.generatedPath, "utf8") !==
      readFileSync(paths.sourcePath, "utf8")
  ) {
    errors.push(
      `${relative(root, markdownPath)}: 静态源码副本缺失或过期: ${href}`,
    );
  }
}

function validateLinks(markdownPath, source) {
  const links = source.matchAll(/\[[^\]]*]\(([^)\s]+)(?:\s+"[^"]*")?\)/g);
  for (const match of links) {
    const href = match[1];
    if (!href || href.startsWith("#") || /^[a-z][a-z+.-]*:/i.test(href)) {
      continue;
    }
    checkedLinks += 1;
    if (href.startsWith("/source/")) {
      validateSourceLink(markdownPath, href);
    }
    const target = localTarget(markdownPath, href);
    if (!target || !existsSync(target) || !statSync(target).isFile()) {
      errors.push(`${relative(root, markdownPath)}: 本地链接不存在: ${href}`);
    }
  }
}

function validatePnpmCommand(markdownPath, line) {
  const tokens = line.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  if (tokens[0] !== "pnpm") {
    return;
  }
  if (tokens[1] === "--filter") {
    const manifest = workspacePackages.get(tokens[2]);
    const script = tokens[3];
    if (!manifest) {
      errors.push(
        `${relative(root, markdownPath)}: 未知 workspace 包: ${tokens[2]}`,
      );
    } else if (script && !["add", "exec", "install"].includes(script)) {
      if (!manifest.scripts?.[script]) {
        errors.push(
          `${relative(root, markdownPath)}: ${tokens[2]} 缺少脚本 ${script}`,
        );
      }
    }
    return;
  }
  const script = tokens[1];
  if (
    script &&
    !["add", "exec", "install", "run"].includes(script) &&
    !rootPackage.scripts?.[script]
  ) {
    errors.push(
      `${relative(root, markdownPath)}: 根 package 缺少脚本 ${script}`,
    );
  }
}

function validateCommands(markdownPath, source) {
  if (/(^|\s)vite preview(?:\s|$)/m.test(source)) {
    errors.push(
      `${relative(root, markdownPath)}: 使用 pnpm workspace 脚本，不要写裸 vite preview`,
    );
  }
  for (const match of source.matchAll(/```bash\n([\s\S]*?)```/g)) {
    const block = match[1] ?? "";
    const syntax = spawnSync("bash", ["-n"], {
      encoding: "utf8",
      input: block,
    });
    if (syntax.status !== 0) {
      errors.push(
        `${relative(root, markdownPath)}: bash 语法错误: ${syntax.stderr.trim()}`,
      );
      continue;
    }
    for (const rawLine of block.split("\n")) {
      const line = rawLine.trim();
      if (
        !line ||
        line.startsWith("#") ||
        line.startsWith("cd ") ||
        line.startsWith("corepack ")
      ) {
        continue;
      }
      checkedCommands += 1;
      validatePnpmCommand(markdownPath, line);
    }
  }
}

async function validateMermaid(markdownPath, source) {
  let index = 0;
  for (const match of source.matchAll(/```mermaid\n([\s\S]*?)```/g)) {
    index += 1;
    checkedDiagrams += 1;
    try {
      await mermaid.parse(match[1] ?? "");
    } catch (error) {
      errors.push(
        `${relative(root, markdownPath)}: Mermaid ${index} 无效: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

function unwrapExpression(node) {
  let current = node;
  while (
    ts.isAsExpression(current) ||
    ts.isParenthesizedExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function propertyName(property) {
  const name = property.name;
  return ts.isIdentifier(name) || ts.isStringLiteral(name)
    ? name.text
    : undefined;
}

function stringValue(node) {
  const value = unwrapExpression(node);
  return ts.isStringLiteral(value) ? value.text : undefined;
}

function readMarkerEvents() {
  const path = join(root, "packages/observability/src/dictionary.ts");
  const sourceFile = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  let dictionary;
  function visit(node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "MARKER_EVENTS" &&
      node.initializer
    ) {
      dictionary = unwrapExpression(node.initializer);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  if (!dictionary || !ts.isObjectLiteralExpression(dictionary)) {
    throw new Error("无法读取 MARKER_EVENTS");
  }
  const result = new Map();
  for (const property of dictionary.properties) {
    if (!ts.isPropertyAssignment(property)) {
      continue;
    }
    const marker = propertyName(property);
    const events = unwrapExpression(property.initializer);
    if (!marker || !ts.isArrayLiteralExpression(events)) {
      continue;
    }
    result.set(
      marker,
      new Set(events.elements.map(stringValue).filter(Boolean)),
    );
  }
  return result;
}

function staticEventPairs(path) {
  const sourceFile = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const pairs = [];
  function visit(node) {
    if (ts.isObjectLiteralExpression(node)) {
      let marker;
      let event;
      for (const property of node.properties) {
        if (!ts.isPropertyAssignment(property)) {
          continue;
        }
        const name = propertyName(property);
        if (name === "marker") {
          marker = stringValue(property.initializer);
        } else if (name === "event") {
          event = stringValue(property.initializer);
        }
      }
      if (marker && event) {
        pairs.push({ event, marker });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return pairs;
}

const markerEvents = readMarkerEvents();

function validateEvent(marker, event, location) {
  documentedEvents.add(`${marker} ${event}`);
  const events = markerEvents.get(marker);
  if (!events) {
    errors.push(`${location}: 未注册日志 marker ${marker}`);
  } else if (!events.has(event)) {
    errors.push(`${location}: 文档日志事件不在字典中: ${marker} ${event}`);
  }
}

function validateDocumentedEvents(markdownPath, source) {
  const location = relative(root, markdownPath);
  for (const line of source.split("\n")) {
    const candidate = line.trim();
    if (candidate.startsWith("{") && candidate.endsWith("}")) {
      try {
        const parsed = JSON.parse(candidate);
        if (
          typeof parsed.marker === "string" &&
          typeof parsed.event === "string"
        ) {
          validateEvent(parsed.marker, parsed.event, location);
        }
      } catch {
        // Non-JSON examples are validated by their fenced language or ignored.
      }
    }
  }
  for (const match of source.matchAll(
    /(\[[A-Z]+])(?:`|\s|:)+`?([a-z][a-z0-9]*(?:[.-][a-z0-9]+)*)(?:\s+([a-z][a-z0-9]*(?:[.-][a-z0-9]+)*))?/g,
  )) {
    const marker = match[1];
    const first = match[2];
    const second = match[3];
    const events = markerEvents.get(marker);
    const event = events?.has(first) ? first : (second ?? first);
    validateEvent(marker, event, location);
  }
}

function validateCapabilityContract() {
  for (const path of [
    join(root, "apps/editor/src/capabilities.ts"),
    join(root, "packages/observability/src/examples.ts"),
  ]) {
    for (const pair of staticEventPairs(path).filter(
      ({ marker }) => marker === "[CAPABILITY]",
    )) {
      validateEvent(pair.marker, pair.event, relative(root, path));
    }
  }
  const capabilityEvents = markerEvents.get("[CAPABILITY]");
  if (
    capabilityEvents?.size !== 1 ||
    !capabilityEvents.has("capability.detected")
  ) {
    errors.push(
      "[CAPABILITY] 必须以 capability.detected 统一代码、字典、示例和文档",
    );
  }
  for (const field of [
    "secureContext",
    "userAgent",
    "actions",
    "capabilities",
    "durationMs",
  ]) {
    for (const path of [
      join(root, "apps/editor/src/capabilities.ts"),
      join(root, "packages/observability/src/dictionary.ts"),
      join(root, "packages/observability/src/examples.ts"),
      join(docsRoot, "capabilities.md"),
    ]) {
      if (!readFileSync(path, "utf8").includes(field)) {
        errors.push(`${relative(root, path)}: capability 字段缺失: ${field}`);
      }
    }
  }
}

function validatePortraitExperimentContract() {
  const docsPath = join(docsRoot, "experiments/assets.md");
  const e2ePath = join(root, "apps/editor/e2e/task17.spec.ts");
  const docsSource = readFileSync(docsPath, "utf8");
  const e2eSource = readFileSync(e2ePath, "utf8");
  const portraitTestStart = e2eSource.indexOf(
    'test("adapts the first test_3 import',
  );
  if (portraitTestStart < 0) {
    errors.push(`${relative(root, e2ePath)}: 找不到 test_3 竖屏验收`);
    return;
  }
  const portraitTest = e2eSource.slice(portraitTestStart);
  const canvasAssertions = [
    ...portraitTest.matchAll(
      /expect\(project\.canvas\)\.toMatchObject\(\{\s*height:\s*(\d+),\s*width:\s*(\d+)\s*\}\)/g,
    ),
  ].map((match) => ({
    height: Number(match[1]),
    width: Number(match[2]),
  }));
  const previewWidth = portraitTest.match(
    /expect\(previewCanvas\)\.toHaveAttribute\("width", "(\d+)"\)/,
  );
  const previewHeight = portraitTest.match(
    /expect\(previewCanvas\)\.toHaveAttribute\("height", "(\d+)"\)/,
  );
  if (
    canvasAssertions.length < 2 ||
    !portraitTest.includes('importAsset(page, "test_1.mp4")')
  ) {
    errors.push(
      `${relative(root, e2ePath)}: test_3 验收必须断言首次导入和后续素材均不改变竖屏画布`,
    );
    return;
  }
  if (!previewWidth || !previewHeight) {
    errors.push(`${relative(root, e2ePath)}: test_3 验收缺少预览尺寸断言`);
    return;
  }

  const expectedCanvas = canvasAssertions[0];
  if (
    canvasAssertions.some(
      (canvas) =>
        canvas.width !== expectedCanvas.width ||
        canvas.height !== expectedCanvas.height,
    )
  ) {
    errors.push(`${relative(root, e2ePath)}: test_3 画布断言前后不一致`);
    return;
  }
  const documentedCanvas = docsSource.match(
    /首次导入[^\n]*Project canvas[^\n]*重设为\s*(\d+)×(\d+)/,
  );
  const documentedPreview = docsSource.match(/预览代理画布为\s*(\d+)×(\d+)/);
  const expectedCanvasText = `${expectedCanvas.width}×${expectedCanvas.height}`;
  const expectedPreviewText = `${previewWidth[1]}×${previewHeight[1]}`;
  if (
    !documentedCanvas ||
    `${documentedCanvas[1]}×${documentedCanvas[2]}` !== expectedCanvasText
  ) {
    errors.push(
      `${relative(root, docsPath)}: test_3 首次导入的 Project canvas 必须与 Task 17 E2E 一致（${expectedCanvasText}）`,
    );
  }
  if (
    !documentedPreview ||
    `${documentedPreview[1]}×${documentedPreview[2]}` !== expectedPreviewText
  ) {
    errors.push(
      `${relative(root, docsPath)}: test_3 预览代理画布必须与 Task 17 E2E 一致（${expectedPreviewText}）`,
    );
  }
  for (const term of [
    "后续导入的素材不会重置 Project canvas",
    "contain/fit",
    "保持宽高比",
    "居中完整显示",
    "不拉伸",
    "不裁切",
    "工程背景色补齐",
  ]) {
    if (!docsSource.includes(term)) {
      errors.push(`${relative(root, docsPath)}: test_3 画布语义缺失: ${term}`);
    }
  }
  if (/添加到默认\s*1920×1080\s*工程/.test(docsSource)) {
    errors.push(
      `${relative(root, docsPath)}: test_3 首次导入后不得仍描述为默认 1920×1080 工程`,
    );
  }
}

function validateAcceptanceConfiguration() {
  const prettierIgnore = readFileSync(join(root, ".prettierignore"), "utf8");
  const eslintConfig = readFileSync(join(root, "eslint.config.mjs"), "utf8");
  const gitIgnore = readFileSync(join(root, ".gitignore"), "utf8");
  const vitepressConfig = readFileSync(
    join(docsRoot, ".vitepress/config.ts"),
    "utf8",
  );
  if (!prettierIgnore.includes(".vitepress/cache/")) {
    errors.push(".prettierignore 未忽略 .vitepress/cache/");
  }
  if (!eslintConfig.includes("**/.vitepress/cache/**")) {
    errors.push("ESLint 未忽略 .vitepress/cache/");
  }
  if (!gitIgnore.includes(".vitepress/cache/")) {
    errors.push(".gitignore 未忽略 .vitepress/cache/");
  }
  if (vitepressConfig.includes("ignoreDeadLinks")) {
    errors.push("VitePress 不得使用 ignoreDeadLinks 掩盖源码死链");
  }
}

async function validateBuiltSite() {
  if (!existsSync(distRoot)) {
    errors.push("VitePress 构建产物不存在");
    return;
  }
  const htmlFiles = filesUnder(distRoot).filter((path) =>
    path.endsWith(".html"),
  );
  const builtSourceRoutes = new Set();
  for (const htmlPath of htmlFiles) {
    const html = readFileSync(htmlPath, "utf8");
    for (const match of html.matchAll(/href="([^"]+)"/g)) {
      const href = match[1];
      if (href?.startsWith("/source/")) {
        builtSourceRoutes.add(href);
      }
    }
    if (/href="(?:\.\.\/)+(?:apps|packages|scripts|\.trae)\//.test(html)) {
      errors.push(`${relative(root, htmlPath)}: 构建产物仍含工作区相对链接`);
    }
  }
  if (builtSourceRoutes.size === 0) {
    errors.push("构建产物中没有可点击的静态源码链接");
    return;
  }

  const server = createServer((request, response) => {
    const pathname = decodeURI(
      new URL(request.url ?? "/", "http://127.0.0.1").pathname,
    );
    const candidate = resolve(distRoot, `.${pathname}`);
    const fromDist = relative(distRoot, candidate);
    if (
      fromDist === ".." ||
      fromDist.startsWith(`..${sep}`) ||
      !existsSync(candidate) ||
      !statSync(candidate).isFile()
    ) {
      response.statusCode = 404;
      response.end("Not Found");
      return;
    }
    response.statusCode = 200;
    response.setHeader("Content-Type", "text/plain; charset=utf-8");
    response.end(readFileSync(candidate));
  });
  await new Promise((resolveListen) =>
    server.listen(0, "127.0.0.1", resolveListen),
  );
  try {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("无法启动构建产物巡检服务");
    }
    await Promise.all(
      [...builtSourceRoutes].map(async (route) => {
        const status = await new Promise((resolveStatus, reject) => {
          const check = request(
            `http://127.0.0.1:${address.port}${route}`,
            { method: "HEAD" },
            (response) => {
              response.resume();
              resolveStatus(response.statusCode);
            },
          );
          check.on("error", reject);
          check.end();
        });
        if (status !== 200) {
          errors.push(`构建产物源码链接 HTTP ${status}: ${route}`);
        }
      }),
    );
  } finally {
    await new Promise((resolveClose, reject) =>
      server.close((error) => (error ? reject(error) : resolveClose())),
    );
  }
  output.log(
    `[DOCS:DIST] html=${htmlFiles.length} sourceLinks=${builtSourceRoutes.size} http=200`,
  );
}

mermaid.initialize({
  htmlLabels: false,
  securityLevel: "loose",
  startOnLoad: false,
});
const markdownFiles = filesUnder(docsRoot).filter((path) =>
  path.endsWith(".md"),
);
for (const markdownPath of markdownFiles) {
  const source = readFileSync(markdownPath, "utf8");
  validateLinks(markdownPath, source);
  validateCommands(markdownPath, source);
  validateDocumentedEvents(markdownPath, source);
  await validateMermaid(markdownPath, source);
}

validateAcceptanceConfiguration();
validateCapabilityContract();
validatePortraitExperimentContract();
if (checkedDiagrams === 0) {
  errors.push("文档中没有 Mermaid 图");
}
if (sourceRoutes.size === 0) {
  errors.push("文档中没有静态源码链接");
}
if (checkDist) {
  await validateBuiltSite();
}
if (errors.length > 0) {
  output.error(`[DOCS] FAIL (${errors.length})`);
  for (const error of errors) {
    output.error(`[DOCS] ${error}`);
  }
  process.exit(1);
}

output.log(
  `[DOCS] PASS files=${markdownFiles.length} localLinks=${checkedLinks} sourceLinks=${sourceRoutes.size} events=${documentedEvents.size} commands=${checkedCommands} mermaid=${checkedDiagrams}`,
);
