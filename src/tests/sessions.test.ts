import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("session store persists, lists, forks, renames and deletes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "euler-sessions-"));
  process.env.EULER_CONFIG_DIR = dir;

  try {
    // Import after setting the env var so config.ts picks up the temp dir.
    const store = await import("../configs/sessions");
    const cwd = "/project/alpha";

    const created = await store.createSession(cwd);
    assert.ok(created.meta.id);
    assert.equal(created.meta.title, "New session");

    const listed = await store.listSessions(cwd);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, created.meta.id);
    assert.equal((await store.listSessions("/other")).length, 0);

    await store.updateSession(created.meta.id, {
      title: "Fix the auth flow",
      messages: [
        {
          id: "m1",
          role: "user",
          content: "hello",
          createdAt: 1
        }
      ],
      conversation: [{ role: "user", content: "hello" }],
      usage: { input: 10, output: 5 }
    });

    const loaded = await store.loadSession(created.meta.id);
    assert.ok(loaded);
    assert.equal(loaded.meta.title, "Fix the auth flow");
    assert.equal(loaded.messages.length, 1);
    assert.equal(loaded.conversation.length, 1);
    assert.deepEqual(loaded.usage, { input: 10, output: 5 });

    const renamed = await store.renameSession(
      created.meta.id,
      "Auth flow"
    );
    assert.equal(renamed?.meta.title, "Auth flow");

    const fork = await store.forkSession(created.meta.id);
    assert.ok(fork);
    assert.notEqual(fork.meta.id, created.meta.id);
    assert.equal(fork.messages.length, 1);
    assert.match(fork.meta.title, /\(fork\)$/);

    assert.equal((await store.listSessions(cwd)).length, 2);

    assert.equal(await store.deleteSession(fork.meta.id), true);
    assert.equal(await store.deleteSession(fork.meta.id), false);
    assert.equal((await store.listSessions(cwd)).length, 1);
  } finally {
    delete process.env.EULER_CONFIG_DIR;
    await rm(dir, { recursive: true, force: true });
  }
});
