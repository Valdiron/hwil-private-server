import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageName = "com.mattel.HWInfiniteLoop";
const obbName = "main.378.com.mattel.HWInfiniteLoop.obb";

async function walk(directory, root = directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(absolute, root)));
    if (entry.isFile()) files.push(path.relative(root, absolute).split(path.sep).join("/"));
  }
  return files;
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export async function buildReplacementData(options = {}) {
  const sourceRoot = path.resolve(
    options.sourceRoot ?? path.join(projectRoot, "replacement-data/source/private-content"),
  );
  const buildRoot = path.resolve(options.buildRoot ?? path.join(projectRoot, "replacement-data/build"));
  const filesystemRoot = path.parse(buildRoot).root;
  if (buildRoot === filesystemRoot || buildRoot === projectRoot || sourceRoot.startsWith(`${buildRoot}${path.sep}`)) {
    throw new Error("Unsafe replacement-data build directory");
  }
  const dataRoot = path.join(
    buildRoot,
    "Android/data",
    packageName,
    "files/private-content",
  );
  const obbDirectory = path.join(buildRoot, "Android/obb", packageName);
  const obbStaging = path.join(buildRoot, "obb-staging/assets/private-content");

  await fs.rm(buildRoot, { recursive: true, force: true });
  await fs.mkdir(dataRoot, { recursive: true });
  await fs.mkdir(obbStaging, { recursive: true });
  await fs.mkdir(obbDirectory, { recursive: true });

  const manifestFiles = [];
  for (const relativePath of await walk(sourceRoot)) {
    const source = path.join(sourceRoot, relativePath);
    const bytes = await fs.readFile(source);
    if (relativePath.endsWith(".json")) JSON.parse(bytes.toString("utf8"));
    for (const destinationRoot of [dataRoot, obbStaging]) {
      const destination = path.join(destinationRoot, relativePath);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.copyFile(source, destination);
    }
    manifestFiles.push({ path: relativePath, bytes: bytes.length, sha256: sha256(bytes) });
  }

  const manifest = {
    schema: "hwil.private.ContentManifest/1",
    packId: "hwil-private-clean-room",
    version: "0.1.0",
    packageName,
    targetClientVersion: "1.35.0",
    originalAssetsIncluded: false,
    originalClientCompatible: false,
    requiresClientBridge: true,
    files: manifestFiles,
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  await fs.writeFile(path.join(dataRoot, "manifest.json"), manifestBytes);
  await fs.writeFile(path.join(obbStaging, "manifest.json"), manifestBytes);

  const obbPath = path.join(obbDirectory, obbName);
  const zip = spawnSync("zip", ["-q", "-X", "-0", "-r", obbPath, "."], {
    cwd: path.join(buildRoot, "obb-staging"),
    encoding: "utf8",
  });
  if (zip.error) throw zip.error;
  if (zip.status !== 0) throw new Error(zip.stderr || `zip exited with status ${zip.status}`);
  await fs.rm(path.join(buildRoot, "obb-staging"), { recursive: true, force: true });

  return {
    buildRoot,
    dataRoot,
    obbPath,
    fileCount: manifestFiles.length,
    manifestSha256: sha256(manifestBytes),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await buildReplacementData();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
