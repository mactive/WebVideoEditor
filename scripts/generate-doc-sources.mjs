import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { Console } from "node:console";
import { dirname, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const docsRoot = join(root, "apps/docs");
const outputRoot = join(docsRoot, "public/source");
const sourceRoutePattern = /\]\(\/source\/([^)#?\s]+)\.txt(?:#[^)\s]*)?\)/g;
const output = new Console({
  stderr: process.stderr,
  stdout: process.stdout,
});

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

function workspaceSource(relativePath) {
  const decoded = decodeURI(relativePath);
  const sourcePath = resolve(root, decoded);
  const fromRoot = relative(root, sourcePath);
  if (
    !fromRoot ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    !existsSync(sourcePath) ||
    !statSync(sourcePath).isFile()
  ) {
    throw new Error(`Invalid documentation source path: ${relativePath}`);
  }
  return { fromRoot, sourcePath };
}

const sources = new Map();
for (const markdownPath of filesUnder(docsRoot).filter((path) =>
  path.endsWith(".md"),
)) {
  const markdown = readFileSync(markdownPath, "utf8");
  for (const match of markdown.matchAll(sourceRoutePattern)) {
    const relativePath = match[1];
    if (relativePath) {
      const source = workspaceSource(relativePath);
      sources.set(source.fromRoot, source.sourcePath);
    }
  }
}

if (sources.size === 0) {
  throw new Error("Documentation does not contain static source links");
}

rmSync(outputRoot, { force: true, recursive: true });
for (const [relativePath, sourcePath] of sources) {
  const outputPath = join(outputRoot, `${relativePath}.txt`);
  mkdirSync(dirname(outputPath), { recursive: true });
  copyFileSync(sourcePath, outputPath);
}

output.log(`[DOCS:SOURCE] generated=${sources.size}`);
