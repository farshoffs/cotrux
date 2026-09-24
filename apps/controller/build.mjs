import { cp, mkdir, rm } from "node:fs/promises";

const files = [
  "index.html",
  "app.css",
  "app.js",
  "manifest.webmanifest",
  "sw.js",
  "icon.svg"
];

await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });

for (const file of files) {
  await cp(file, "dist/" + file);
}

console.log("Cotrux controller built to apps/controller/dist");
