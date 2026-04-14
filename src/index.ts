#!/usr/bin/env node
// CLI entry point. Usage:
//   node src/index.ts                    # read stdin
//   node src/index.ts path/to.log        # read file
//   node src/index.ts --demo             # run all bundled examples
//   node src/index.ts --debug ...        # include normalized events in output

import { readFileSync, readdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./pipeline.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXAMPLES = join(__dirname, "..", "examples");

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
  });
}

function printResult(label: string | null, result: unknown): void {
  if (label) console.log(`\n=== ${label} ===`);
  console.log(JSON.stringify(result, null, 2));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const debug = args.includes("--debug");
  const rest = args.filter((a) => a !== "--debug");

  if (rest.includes("--demo")) {
    const files = readdirSync(EXAMPLES).filter((f) => f.endsWith(".log")).sort();
    for (const f of files) {
      const raw = readFileSync(join(EXAMPLES, f), "utf8");
      const result = run(raw, { debug });
      printResult(basename(f), result);
    }
    return;
  }

  let raw: string;
  if (rest.length > 0) {
    raw = readFileSync(rest[0]!, "utf8");
  } else if (!process.stdin.isTTY) {
    raw = await readStdin();
  } else {
    console.error(
      "Usage:\n" +
        "  node src/index.ts <file.log>\n" +
        "  node src/index.ts --demo\n" +
        "  cat logs | node src/index.ts",
    );
    process.exit(1);
  }

  const result = run(raw, { debug });
  printResult(null, result);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
