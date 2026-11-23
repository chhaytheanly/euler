import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Tools capture the workspace and config directories at import time, so point
// both at temporary locations before loading them.
const sandbox = await mkdtemp(join(tmpdir(), "euler-tools-"));
const configDir = await mkdtemp(join(tmpdir(), "euler-config-"));
const previousCwd = process.cwd();
process.env.EULER_CONFIG_DIR = configDir;
process.chdir(sandbox);

const { executeToolCall } = await import("../tools/index");
const { undoLastBackup } = await import("../tools/journal");

after(async () => {
  process.chdir(previousCwd);
  await rm(sandbox, { recursive: true, force: true });
  await rm(configDir, { recursive: true, force: true });
});

function call(name: string, args: Record<string, unknown>) {
  return executeToolCall(
    {
      id: `test_${Math.random().toString(16).slice(2)}`,
      name,
      arguments: JSON.stringify(args)
    },
    { root: sandbox, signal: new AbortController().signal }
  );
}

test("create_file creates nested files and refuses to overwrite", async () => {
  const content =
    Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join(
      "\n"
    ) + "\n";

  const created = await call("create_file", {
    path: "src/nested/a.txt",
    content
  });
  assert.equal(created.ok, true);
  assert.match(created.content, /Created src\/nested\/a\.txt/);
  assert.equal(
    await readFile(join(sandbox, "src/nested/a.txt"), "utf8"),
    content
  );

  const again = await call("create_file", {
    path: "src/nested/a.txt",
    content: "different"
  });
  assert.equal(again.ok, false);
  assert.match(again.content, /already exists/);
  assert.equal(
    await readFile(join(sandbox, "src/nested/a.txt"), "utf8"),
    content
  );
});

test("read_file pages with offset/limit and keeps legacy ranges working", async () => {
  const paged = await call("read_file", {
    path: "src/nested/a.txt",
    offset: 4,
    limit: 3
  });
  assert.equal(paged.ok, true);
  assert.match(paged.content, /lines 5-7 of 12/);
  assert.match(paged.content, /5 \| line 5/);
  assert.match(paged.content, /offset=7/);

  const legacy = await call("read_file", {
    path: "src/nested/a.txt",
    startLine: 2,
    endLine: 3
  });
  assert.equal(legacy.ok, true);
  assert.match(legacy.content, /lines 2-3 of 12/);
});

test("write_file detects identical content", async () => {
  const before = await readFile(join(sandbox, "src/nested/a.txt"), "utf8");
  const result = await call("write_file", {
    path: "src/nested/a.txt",
    content: before
  });
  assert.equal(result.ok, true);
  assert.match(result.content, /No change/);
});

test("edit_file accepts alias keys and hints at a close match", async () => {
  const edited = await call("edit_file", {
    path: "src/nested/a.txt",
    oldString: "line 3",
    newString: "LINE THREE"
  });
  assert.equal(edited.ok, true);
  assert.match(
    await readFile(join(sandbox, "src/nested/a.txt"), "utf8"),
    /LINE THREE/
  );

  const missing = await call("edit_file", {
    path: "src/nested/a.txt",
    oldText: "lin 5",
    newText: "SHOULD NOT APPLY"
  });
  assert.equal(missing.ok, false);
  assert.match(missing.content, /Closest match/);
});

test("multi_edit is atomic and applies ordered edits to the same file", async () => {
  const original = "alpha\nbeta\ngamma\n";
  await call("create_file", { path: "batch.txt", content: original });

  const rejected = await call("multi_edit", {
    edits: [
      { path: "batch.txt", oldText: "alpha", newText: "ALPHA" },
      { path: "batch.txt", oldText: "missing", newText: "X" }
    ]
  });
  assert.equal(rejected.ok, false);
  assert.equal(await readFile(join(sandbox, "batch.txt"), "utf8"), original);

  const applied = await call("multi_edit", {
    edits: [
      { path: "batch.txt", oldString: "alpha", newString: "ALPHA" },
      { path: "batch.txt", oldString: "beta", newString: "BETA" }
    ]
  });
  assert.equal(applied.ok, true);
  assert.match(applied.content, /2 edit\(s\) across 1 file/);
  assert.equal(
    await readFile(join(sandbox, "batch.txt"), "utf8"),
    "ALPHA\nBETA\ngamma\n"
  );
});

test("undo removes a file created with create_file", async () => {
  await call("create_file", { path: "temp/new.txt", content: "hello\n" });
  const undone = await undoLastBackup();
  assert.match(undone ?? "", /removed temp\/new\.txt/);
  await assert.rejects(readFile(join(sandbox, "temp/new.txt")));
});
