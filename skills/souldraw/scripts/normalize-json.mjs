#!/usr/bin/env node

import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const args = new Set(process.argv.slice(2));
const checkOnly = args.has("--check");
const writeMode = args.has("--write") || !checkOnly;

const EXCLUDED_DIRS = new Set([
  ".git",
  ".github",
  "node_modules",
  ".vscode",
  "dist",
  "build",
]);

function isJsonFile(filePath) {
  return filePath.endsWith(".json") && !filePath.endsWith(".jsonl");
}

function isJsonlFile(filePath) {
  return filePath.endsWith(".jsonl");
}

function sortJsonValue(value) {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (value && typeof value === "object") {
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortJsonValue(value[key]);
    }
    return sorted;
  }
  return value;
}

function normalizeJsonText(content) {
  const parsed = JSON.parse(content);
  const sorted = sortJsonValue(parsed);
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

function normalizeJsonlText(content) {
  const lines = content.split(/\r?\n/);
  const normalizedLines = [];

  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    const parsed = JSON.parse(line);
    const sorted = sortJsonValue(parsed);
    normalizedLines.push(JSON.stringify(sorted));
  }

  return normalizedLines.length > 0
    ? `${normalizedLines.join("\n")}\n`
    : "";
}

async function collectTargetFiles(dirPath) {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRS.has(entry.name)) {
        files.push(...(await collectTargetFiles(fullPath)));
      }
      continue;
    }
    if (isJsonFile(fullPath) || isJsonlFile(fullPath)) {
      files.push(fullPath);
    }
  }

  return files;
}

async function normalizeOneFile(filePath) {
  const original = await fs.readFile(filePath, "utf8");
  const normalized = isJsonlFile(filePath)
    ? normalizeJsonlText(original)
    : normalizeJsonText(original);

  if (normalized === original) {
    return false;
  }

  if (writeMode) {
    await fs.writeFile(filePath, normalized, "utf8");
  }

  return true;
}

async function main() {
  const targetFiles = await collectTargetFiles(repoRoot);
  const changedFiles = [];
  const failedFiles = [];

  for (const filePath of targetFiles.sort()) {
    try {
      const changed = await normalizeOneFile(filePath);
      if (changed) {
        changedFiles.push(filePath);
      }
    } catch (error) {
      failedFiles.push({ filePath, message: String(error.message || error) });
    }
  }

  if (failedFiles.length > 0) {
    for (const failure of failedFiles) {
      console.error(`Failed: ${path.relative(repoRoot, failure.filePath)} -> ${failure.message}`);
    }
    process.exit(1);
  }

  const modeLabel = writeMode ? "updated" : "would update";
  if (changedFiles.length === 0) {
    console.log("JSON/JSONL already normalized.");
  } else {
    console.log(`JSON/JSONL ${modeLabel} (${changedFiles.length} files):`);
    for (const filePath of changedFiles) {
      console.log(`- ${path.relative(repoRoot, filePath)}`);
    }
  }

  if (checkOnly && changedFiles.length > 0) {
    process.exit(2);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
