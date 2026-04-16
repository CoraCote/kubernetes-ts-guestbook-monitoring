#!/usr/bin/env node
/**
 * Local checks that do not require a Kubernetes cluster.
 * Run via: npm test
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

// Dashboard JSON must parse
const dashPath = path.join(root, "dashboards", "guestbook.json");
if (!fs.existsSync(dashPath)) fail(`missing ${dashPath}`);
try {
  const j = JSON.parse(fs.readFileSync(dashPath, "utf8"));
  if (j.title !== "Guestbook overview") fail("dashboard title unexpected");
  if (!Array.isArray(j.panels) || j.panels.length < 1) fail("dashboard panels missing");
} catch (e) {
  fail(`invalid JSON in guestbook.json: ${e}`);
}

// index.ts exists
const idx = path.join(root, "index.ts");
if (!fs.existsSync(idx)) fail("missing index.ts");

console.log("OK: dashboard JSON valid, index.ts present.");
