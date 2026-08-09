import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";

await rm(new URL("../.wrangler/deploy/config.json", import.meta.url), { force: true });

const command = process.platform === "win32" ? "wrangler.cmd" : "wrangler";
const child = spawn(command, ["pages", "deploy", "pages-dist", "--project-name", "mosi-bkchou", "--branch", "main"], {
  stdio: "inherit",
});

child.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});

child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
