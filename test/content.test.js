import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildReplacementData } from "../tools/build-replacement-data.mjs";

test("builds a validated replacement data tree and structural OBB", async (t) => {
  const buildRoot = await fs.mkdtemp(path.join(os.tmpdir(), "hwil-replacement-data-"));
  t.after(() => fs.rm(buildRoot, { recursive: true, force: true }));

  const result = await buildReplacementData({ buildRoot });
  assert.ok(result.fileCount >= 10);

  const manifest = JSON.parse(await fs.readFile(path.join(result.dataRoot, "manifest.json"), "utf8"));
  assert.equal(manifest.originalAssetsIncluded, false);
  assert.equal(manifest.requiresClientBridge, true);
  assert.equal(manifest.files.length, result.fileCount);

  for (const entry of manifest.files) {
    const bytes = await fs.readFile(path.join(result.dataRoot, entry.path));
    assert.equal(bytes.length, entry.bytes);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), entry.sha256);
  }

  const obbPrefix = Buffer.alloc(2);
  const obb = await fs.open(result.obbPath, "r");
  await obb.read(obbPrefix, 0, 2, 0);
  await obb.close();
  assert.equal(obbPrefix.toString("hex"), "504b");
});

