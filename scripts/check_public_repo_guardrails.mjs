#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const LOCAL_ENV_FILES = [".env", ".env.local"];
const FORBIDDEN_DIR_PATTERNS = [/^data\//, /^\.runtime\//];
const FORBIDDEN_FILE_PATTERNS = [
  /\.db$/i,
  /\.sqlite$/i,
  /\.sqlite3$/i,
  /\.csv$/i,
  /\.tsv$/i,
  /\.jsonl$/i,
];

const ALLOWED_DB_CREATION_PATHS = [
  /^prisma\/schema\.prisma$/,
  /^prisma\/migrations\/[^/]+\/migration\.sql$/,
  /^db\/init\.sql$/,
  /^db\/migrations\/.*\.sql$/,
];

const SQL_DATA_MUTATION_PATTERN = /\b(insert\s+into|copy\s+\w+\s+from|update\s+\w+\s+set|delete\s+from)\b/i;

function toPosix(value) {
  return String(value).split(path.sep).join("/");
}

function parseEnvEntries(content) {
  const entries = [];
  for (const line of String(content).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const key = match[1];
    let value = match[2].trim();
    if (!(value.startsWith('"') || value.startsWith("'"))) {
      const commentPos = value.indexOf(" #");
      if (commentPos >= 0) value = value.slice(0, commentPos).trim();
    }
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1).trim();
    }
    entries.push({ key, value });
  }
  return entries;
}

function getTrackedFiles(errors) {
  const result = spawnSync("git", ["ls-files", "-z"], {
    cwd: ROOT,
    encoding: "utf-8",
  });
  if (result.status !== 0) {
    const detail = [String(result.stderr || "").trim(), String(result.stdout || "").trim()].filter(Boolean).join(" | ");
    errors.push(`Unable to read tracked files via git ls-files${detail ? `: ${detail}` : ""}`);
    return [];
  }
  return String(result.stdout || "")
    .split("\u0000")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => toPosix(entry));
}

function checkTrackedEnvFiles(errors, trackedFiles) {
  const trackedEnv = trackedFiles.filter((file) => {
    const base = path.posix.basename(file);
    if (!base.startsWith(".env")) return false;
    if (base === ".env.example" || base.endsWith(".example")) return false;
    return true;
  });
  if (trackedEnv.length > 0) {
    errors.push(`Tracked env files are not allowed: ${trackedEnv.join(", ")}`);
  }
}

function checkLocalEnvValues(errors) {
  for (const relativePath of LOCAL_ENV_FILES) {
    const fullPath = path.join(ROOT, relativePath);
    if (!fs.existsSync(fullPath)) continue;
    const entries = parseEnvEntries(fs.readFileSync(fullPath, "utf-8"));
    const populated = entries.filter((entry) => String(entry.value || "").trim().length > 0);
    if (!populated.length) continue;
    const keys = populated.slice(0, 12).map((entry) => entry.key);
    const suffix = populated.length > keys.length ? ", ..." : "";
    errors.push(`Local env data detected in ${relativePath}: ${keys.join(", ")}${suffix}`);
  }
}

function isAllowedDbCreationPath(relativePath) {
  return ALLOWED_DB_CREATION_PATHS.some((pattern) => pattern.test(relativePath));
}

function checkNoBusinessOrDbData(errors, trackedFiles) {
  for (const relativePath of trackedFiles) {
    if (FORBIDDEN_DIR_PATTERNS.some((pattern) => pattern.test(relativePath))) {
      errors.push(`Forbidden data directory content tracked: ${relativePath}`);
      continue;
    }

    if (FORBIDDEN_FILE_PATTERNS.some((pattern) => pattern.test(relativePath))) {
      errors.push(`Forbidden business/database data file tracked: ${relativePath}`);
      continue;
    }

    if (/\.sql$/i.test(relativePath)) {
      if (!isAllowedDbCreationPath(relativePath)) {
        errors.push(`Only DB creation SQL scripts are allowed. Found: ${relativePath}`);
        continue;
      }

      const fullPath = path.join(ROOT, relativePath);
      let content = "";
      try {
        content = fs.readFileSync(fullPath, "utf-8");
      } catch {
        continue;
      }
      if (SQL_DATA_MUTATION_PATTERN.test(content)) {
        errors.push(`SQL file appears to contain data mutation statements (not creation-only): ${relativePath}`);
      }
    }
  }
}

function run() {
  const errors = [];
  const trackedFiles = getTrackedFiles(errors);
  checkTrackedEnvFiles(errors, trackedFiles);
  checkLocalEnvValues(errors);
  checkNoBusinessOrDbData(errors, trackedFiles);

  if (errors.length > 0) {
    console.error("Public repo guardrails failed:");
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  }

  console.log("Public repo guardrails passed.");
}

run();
