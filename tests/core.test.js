"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Core = require("../core.js");

// ---------- parseCommand ----------

test("parseCommand splits a simple command", () => {
  const p = Core.parseCommand("ls /home/operator");
  assert.equal(p.ok, true);
  assert.equal(p.name, "ls");
  assert.deepEqual(p.args, ["/home/operator"]);
  assert.deepEqual(p.flags, {});
});

test("parseCommand groups short flags and reads long flags", () => {
  const p = Core.parseCommand("ls -la /vault");
  assert.deepEqual(p.args, ["/vault"]);
  assert.equal(p.flags.l, true);
  assert.equal(p.flags.a, true);
  const p2 = Core.parseCommand("ls --all /vault");
  assert.equal(p2.flags.all, true);
  assert.deepEqual(p2.args, ["/vault"]);
});

test("parseCommand keeps quoted words together", () => {
  const p = Core.parseCommand('cat "my file.txt"');
  assert.deepEqual(p.args, ["my file.txt"]);
  const p2 = Core.parseCommand("echo 'hello world'");
  assert.deepEqual(p2.args, ["hello world"]);
});

test("parseCommand rejects an empty command", () => {
  assert.equal(Core.parseCommand("").ok, false);
  assert.equal(Core.parseCommand("   ").ok, false);
  assert.equal(Core.parseCommand(null).ok, false);
});

test("parseCommand stops flag parsing after --", () => {
  const p = Core.parseCommand("echo -- -n");
  assert.deepEqual(p.args, ["-n"]);
  assert.deepEqual(p.flags, {});
});

// ---------- normalizePath ----------

test("normalizePath resolves relative paths against cwd", () => {
  assert.equal(Core.normalizePath("/home/operator", "notes.txt"), "/home/operator/notes.txt");
  assert.equal(Core.normalizePath("/home/operator", "./notes.txt"), "/home/operator/notes.txt");
  assert.equal(Core.normalizePath("/home/operator/projects", "../notes.txt"), "/home/operator/notes.txt");
  assert.equal(Core.normalizePath("/home/operator", "../../vault"), "/vault");
  assert.equal(Core.normalizePath("/anywhere", "/vault"), "/vault");
});

test("normalizePath handles ~, root and dot-dot past root", () => {
  assert.equal(Core.normalizePath("/vault", "~"), "/home/operator");
  assert.equal(Core.normalizePath("/vault", "~/projects"), "/home/operator/projects");
  assert.equal(Core.normalizePath("/", ".."), "/");
  assert.equal(Core.normalizePath("/home/operator", ""), "/home/operator");
  assert.equal(Core.normalizePath("/home/operator", "//system//core.txt"), "/system/core.txt");
});

// ---------- initial state ----------

test("initial state has the quest fixtures in place", () => {
  const s = Core.createInitialState();
  assert.equal(s.cwd, "/home/operator");
  assert.equal(s.tick, 0);
  const ghost = Core.resolveNode(s, Core.HIDDEN_PATH);
  assert.equal(ghost.type, "file");
  assert.equal(ghost.hidden, true);
  const vault = Core.resolveNode(s, "/vault");
  assert.equal(vault.type, "dir");
  assert.equal(vault.locked, true);
  assert.ok(Core.resolveNode(s, "/vault/wake.sh"));
  assert.equal(Core.isPathLocked(s, "/vault/wake.sh"), true);
  assert.equal(Core.isPathLocked(s, "/home/operator/readme.txt"), false);
  assert.deepEqual(Core.getQuestStatus(s).map((q) => q.done), [false, false, false]);
  assert.equal(Core.allQuestsDone(s), false);
});

test("createInitialState returns independent copies", () => {
  const a = Core.createInitialState();
  const b = Core.createInitialState();
  a.fs.children.vault.locked = false;
  assert.equal(b.fs.children.vault.locked, true);
});

// ---------- applyStatePatch: happy paths ----------

test("applyStatePatch creates, writes and deletes files", () => {
  const s = Core.createInitialState();
  let r = Core.applyStatePatch(s, { create_files: [{ path: "hello.txt", content: "hi" }] });
  assert.equal(r.ok, true);
  assert.equal(Core.resolveNode(r.state, "/home/operator/hello.txt").content, "hi");
  assert.equal(r.state.tick, 1);
  // the original state is untouched
  assert.equal(Core.resolveNode(s, "/home/operator/hello.txt"), null);

  r = Core.applyStatePatch(r.state, { write_files: [{ path: "hello.txt", content: "changed" }] });
  assert.equal(r.ok, true);
  assert.equal(Core.resolveNode(r.state, "/home/operator/hello.txt").content, "changed");

  r = Core.applyStatePatch(r.state, { delete_paths: ["hello.txt"] });
  assert.equal(r.ok, true);
  assert.equal(Core.resolveNode(r.state, "/home/operator/hello.txt"), null);
});

test("applyStatePatch changes cwd, env and flags", () => {
  const s = Core.createInitialState();
  const r = Core.applyStatePatch(s, {
    cwd: "/system",
    set_env: { MOOD: "calm" },
    set_flags: { hidden_found: true }
  });
  assert.equal(r.ok, true);
  assert.equal(r.state.cwd, "/system");
  assert.equal(r.state.env.MOOD, "calm");
  assert.equal(r.state.flags.hidden_found, true);
  const r2 = Core.applyStatePatch(r.state, { unset_env: ["MOOD"] });
  assert.equal(r2.state.env.MOOD, undefined);
});

test("an empty patch is legal and only advances the tick", () => {
  const s = Core.createInitialState();
  const r = Core.applyStatePatch(s, {});
  assert.equal(r.ok, true);
  assert.equal(r.state.tick, 1);
});

// ---------- applyStatePatch: validation failures ----------

test("a bad patch changes nothing at all", () => {
  const s = Core.createInitialState();
  const before = JSON.stringify(s);
  const r = Core.applyStatePatch(s, {
    create_files: [{ path: "ok.txt", content: "fine" }],
    cwd: "/does/not/exist"
  });
  assert.equal(r.ok, false);
  assert.equal(JSON.stringify(r.state), before);
  assert.equal(JSON.stringify(s), before);
});

test("applyStatePatch rejects unknown keys and oversized content", () => {
  const s = Core.createInitialState();
  assert.equal(Core.applyStatePatch(s, { rm_rf: ["/"] }).ok, false);
  assert.equal(Core.applyStatePatch(s, { create_files: [{ path: "big.txt", content: "x".repeat(2001) }] }).ok, false);
  assert.equal(Core.applyStatePatch(s, null).ok, false);
  assert.equal(Core.applyStatePatch(s, []).ok, false);
});

test("applyStatePatch rejects file ops that break the tree", () => {
  const s = Core.createInitialState();
  // create over an existing file
  assert.equal(Core.applyStatePatch(s, { create_files: [{ path: "readme.txt", content: "x" }] }).ok, false);
  // write to a directory
  assert.equal(Core.applyStatePatch(s, { write_files: [{ path: "/system", content: "x" }] }).ok, false);
  // write a missing file
  assert.equal(Core.applyStatePatch(s, { write_files: [{ path: "nope.txt", content: "x" }] }).ok, false);
  // delete the root, delete a non-empty directory
  assert.equal(Core.applyStatePatch(s, { delete_paths: ["/"] }).ok, false);
  assert.equal(Core.applyStatePatch(s, { delete_paths: ["/home"] }).ok, false);
  // create inside a locked directory
  assert.equal(Core.applyStatePatch(s, { create_files: [{ path: "/vault/new.txt", content: "x" }] }).ok, false);
  // cwd into a file or a locked directory
  assert.equal(Core.applyStatePatch(s, { cwd: "/system/core.txt" }).ok, false);
  assert.equal(Core.applyStatePatch(s, { cwd: "/vault" }).ok, false);
});

test("applyStatePatch rejects bad env names and values", () => {
  const s = Core.createInitialState();
  assert.equal(Core.applyStatePatch(s, { set_env: { lower: "x" } }).ok, false);
  assert.equal(Core.applyStatePatch(s, { set_env: { GOOD: "x".repeat(101) } }).ok, false);
  assert.equal(Core.applyStatePatch(s, { set_env: { GOOD: 42 } }).ok, false);
});

test("validateStatePatch mirrors applyStatePatch", () => {
  const s = Core.createInitialState();
  assert.deepEqual(Core.validateStatePatch(s, { cwd: "/system" }), { ok: true, errors: [] });
  const bad = Core.validateStatePatch(s, { cwd: "/vault" });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.length > 0);
});

// ---------- unlock rules ----------

test("unlock needs the right passphrase and flips the quest flag", () => {
  const s = Core.createInitialState();
  assert.equal(Core.applyStatePatch(s, { unlock: [{ path: "/vault" }] }).ok, false);
  assert.equal(Core.applyStatePatch(s, { unlock: [{ path: "/vault", passphrase: "wrong" }] }).ok, false);
  const r = Core.applyStatePatch(s, { unlock: [{ path: "/vault", passphrase: "lantern" }] });
  assert.equal(r.ok, true);
  assert.equal(r.state.flags.vault_unlocked, true);
  assert.equal(Core.isPathLocked(r.state, "/vault/wake.sh"), false);
  // unlocking again fails, it is not locked anymore
  assert.equal(Core.applyStatePatch(r.state, { unlock: [{ path: "/vault", passphrase: "lantern" }] }).ok, false);
});

test("vault_unlocked cannot be set directly, and locking reverts it", () => {
  const s = Core.createInitialState();
  assert.equal(Core.applyStatePatch(s, { set_flags: { vault_unlocked: true } }).ok, false);
  const unlocked = Core.applyStatePatch(s, { unlock: [{ path: "/vault", passphrase: "lantern" }] }).state;
  const relocked = Core.applyStatePatch(unlocked, { lock: ["/vault"] });
  assert.equal(relocked.ok, true);
  assert.equal(relocked.state.flags.vault_unlocked, false);
});

test("core_awake is gated on the vault being unlocked", () => {
  const s = Core.createInitialState();
  assert.equal(Core.applyStatePatch(s, { set_flags: { core_awake: true } }).ok, false);
  const unlocked = Core.applyStatePatch(s, { unlock: [{ path: "/vault", passphrase: "lantern" }] }).state;
  const r = Core.applyStatePatch(unlocked, { set_flags: { core_awake: true } });
  assert.equal(r.ok, true);
  assert.equal(r.state.flags.core_awake, true);
});

test("set_flags rejects unknown flags and non booleans", () => {
  const s = Core.createInitialState();
  assert.equal(Core.applyStatePatch(s, { set_flags: { god_mode: true } }).ok, false);
  assert.equal(Core.applyStatePatch(s, { set_flags: { hidden_found: "yes" } }).ok, false);
});

// ---------- parseModelResponse ----------

test("parseModelResponse accepts strict JSON", () => {
  const r = Core.parseModelResponse('{"output":"hello","state_patch":{"cwd":"/system"}}');
  assert.equal(r.ok, true);
  assert.equal(r.output, "hello");
  assert.equal(r.patch.cwd, "/system");
});

test("parseModelResponse accepts fenced and buried JSON", () => {
  const fenced = Core.parseModelResponse("```json\n{\"output\":\"hi\",\"state_patch\":{}}\n```");
  assert.equal(fenced.ok, true);
  const buried = Core.parseModelResponse('Sure! {"output":"hi"} hope that helps');
  assert.equal(buried.ok, true);
  assert.deepEqual(buried.patch, {});
});

test("parseModelResponse rejects broken replies", () => {
  assert.equal(Core.parseModelResponse("").ok, false);
  assert.equal(Core.parseModelResponse(null).ok, false);
  assert.equal(Core.parseModelResponse("no json here").ok, false);
  assert.equal(Core.parseModelResponse('{"state_patch":{}}').ok, false);
  assert.equal(Core.parseModelResponse('{"output":""}').ok, false);
  assert.equal(Core.parseModelResponse('{"output":"hi","state_patch":[]}').ok, false);
  assert.equal(Core.parseModelResponse('{"output":"' + "x".repeat(8001) + '"}').ok, false);
});

// ---------- parseChatResponse ----------

test("parseChatResponse extracts text and surfaces errors", () => {
  const ok = Core.parseChatResponse({ choices: [{ message: { content: "answer" }, finish_reason: "stop" }] });
  assert.equal(ok.ok, true);
  assert.equal(ok.text, "answer");
  const err = Core.parseChatResponse({ error: { message: "bad key" } });
  assert.equal(err.ok, false);
  assert.equal(err.error, "bad key");
  assert.equal(Core.parseChatResponse({ choices: [{ message: { content: "  " } }] }).ok, false);
  assert.equal(Core.parseChatResponse(null).ok, false);
});

// ---------- buildChatRequest / buildPrompt ----------

test("buildChatRequest carries state, command and the JSON contract", () => {
  const s = Core.createInitialState();
  const req = Core.buildChatRequest("z-ai/glm-5.3-flash", s, "ls -a", []);
  assert.equal(req.model, "z-ai/glm-5.3-flash");
  assert.equal(req.reasoning_effort, "low");
  assert.ok(req.max_tokens >= 2000);
  assert.equal(req.messages.length, 2);
  const body = req.messages[1].content;
  assert.ok(body.includes("ls -a"));
  assert.ok(body.includes("/vault"));
  assert.ok(body.includes(".ghost.txt"));
  assert.ok(body.includes('"output"'));
  assert.ok(body.includes("state_patch"));
});

test("buildPrompt includes recent history", () => {
  const s = Core.createInitialState();
  const prompt = Core.buildPrompt(s, "pwd", [{ command: "ls", output: "readme.txt" }]);
  assert.ok(prompt.includes("$ ls"));
  assert.ok(prompt.includes("The user just typed: pwd"));
});

// ---------- validateKey ----------

test("validateKey checks format locally", () => {
  assert.equal(Core.validateKey("sk_" + "a".repeat(24)).ok, true);
  assert.equal(Core.validateKey("pk_" + "a".repeat(24)).ok, true);
  assert.equal(Core.validateKey("").ok, false);
  assert.equal(Core.validateKey("nope").ok, false);
  assert.equal(Core.validateKey("sk_short").ok, false);
  assert.equal(Core.validateKey("sk_has space in it here").ok, false);
  assert.equal(Core.validateKey(42).ok, false);
});

// ---------- demo mode and the quest chain ----------

test("demo ls hides the ghost file, ls -a shows it", () => {
  const s = Core.createInitialState();
  const plain = Core.demoRespond(s, "ls");
  assert.ok(plain.output.includes("readme.txt"));
  assert.ok(!plain.output.includes(".ghost.txt"));
  const all = Core.demoRespond(s, "ls -a");
  assert.ok(all.output.includes(".ghost.txt"));
});

test("demo cat of the ghost file completes the hidden quest through a patch", () => {
  const s = Core.createInitialState();
  const r = Core.demoRespond(s, "cat .ghost.txt");
  assert.ok(r.output.includes("lantern"));
  assert.deepEqual(r.patch, { set_flags: { hidden_found: true } });
  const applied = Core.applyStatePatch(s, r.patch);
  assert.equal(applied.ok, true);
  assert.equal(Core.getQuestStatus(applied.state)[0].done, true);
});

test("demo vault stays shut without the passphrase and opens with it", () => {
  const s = Core.createInitialState();
  assert.ok(Core.demoRespond(s, "ls /vault").output.includes("Permission denied"));
  assert.ok(Core.demoRespond(s, "cat /vault/core.key").output.includes("Permission denied"));
  assert.ok(Core.demoRespond(s, "unlock /vault wrong").output.includes("wrong passphrase"));
  const open = Core.demoRespond(s, "unlock /vault lantern");
  assert.ok(open.output.includes("unlocked"));
  const applied = Core.applyStatePatch(s, open.patch);
  assert.equal(applied.ok, true);
  assert.ok(Core.demoRespond(applied.state, "ls /vault").output.includes("wake.sh"));
});

test("demo full quest chain: hidden, vault, wake the core", () => {
  let s = Core.createInitialState();
  const step = (cmd) => {
    const r = Core.demoRespond(s, cmd);
    if (r.patch) {
      const applied = Core.applyStatePatch(s, r.patch);
      assert.equal(applied.ok, true, cmd + " patch should apply");
      s = applied.state;
    }
    return r;
  };
  step("cat .ghost.txt");
  step("unlock /vault lantern");
  const wake = step("run /vault/wake.sh");
  assert.ok(wake.output.includes("CORE AWAKE"));
  assert.equal(Core.allQuestsDone(s), true);
});

test("demo run of wake.sh is denied while the vault is locked", () => {
  const s = Core.createInitialState();
  assert.ok(Core.demoRespond(s, "run /vault/wake.sh").output.includes("Permission denied"));
});

test("demo handles help, pwd, cd and unknown commands", () => {
  const s = Core.createInitialState();
  assert.ok(Core.demoRespond(s, "help").output.includes("ls [-a]"));
  assert.equal(Core.demoRespond(s, "pwd").output, "/home/operator");
  const cd = Core.demoRespond(s, "cd /system");
  assert.deepEqual(cd.patch, { cwd: "/system" });
  assert.ok(Core.demoRespond(s, "frobnicate").output.includes("demo mode"));
  assert.ok(Core.demoRespond(s, "cat /vault").output.includes("Is a directory"));
});

// ---------- serializeState ----------

test("serializeState shows the machine the model has to stay true to", () => {
  const text = Core.serializeState(Core.createInitialState());
  assert.ok(text.includes("cwd: /home/operator"));
  assert.ok(text.includes("[locked]"));
  assert.ok(text.includes("[hidden]"));
  assert.ok(text.includes("hidden=open"));
});
