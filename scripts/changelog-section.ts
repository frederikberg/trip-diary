#!/usr/bin/env bun
// Prints the CHANGELOG.md section of a version (`bun scripts/changelog-section.ts 1.2.3`) and fails when there is none.
import { readFileSync } from "node:fs";

const version = process.argv[2]?.replace(/^v/, "");
if (!version) throw new Error("usage: changelog-section.ts <version>");
const lines = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8").split("\n");
const start = lines.findIndex((l) => l.startsWith(`## [${version}]`));
if (start < 0) {
  console.error(`CHANGELOG.md has no section for ${version}`);
  process.exit(1);
}
const end = lines.findIndex((l, i) => i > start && /^## \[|^\[.+\]: /.test(l));
console.log(
  lines
    .slice(start + 1, end < 0 ? undefined : end)
    .join("\n")
    .trim(),
);
