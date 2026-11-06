"use strict";

// Core logic for Machine Mind.
// Runs in the browser as window.MachineMind and in node for tests.
// No network code lives here. The page layer passes raw model responses
// in, and this module decides if a state patch is legal, applies it,
// and keeps the fictional machine consistent.
//
// The model plays the machine. The app owns the truth: a real state
// object with a filesystem, a current directory, env vars, flags and
// quest progress. Every turn the state goes into the prompt, and the
// model answers with strict JSON { output, state_patch }. Patches are
// validated here before anything changes. A bad patch changes nothing.

var API_BASE = "https://gen.pollinations.ai";
var STORAGE_KEY = "machine_mind_pollinations_key";
var STATE_STORAGE_KEY = "machine_mind_state_v1";

var HOME = "/home/operator";
var HIDDEN_PATH = "/home/operator/.ghost.txt";
var VAULT_PATH = "/vault";
var WAKE_PATH = "/vault/wake.sh";

var MODELS = [
  { id: "z-ai/glm-5.3-flash", label: "GLM 5.3 Flash (default, cheap)" },
  { id: "openai/gpt-5.4-nano", label: "GPT-5.4 Nano" },
  { id: "deepseek/deepseek-v4-flash", label: "DeepSeek V4 Flash" },
  { id: "moonshotai/kimi-k2.6", label: "Kimi K2.6" },
  { id: "community/morriszdweck/glm-5.3-flash-free", label: "GLM 5.3 Flash Free (community)" },
  { id: "mistralai/mistral-large-3", label: "Mistral Large 3" }
];
var DEFAULT_MODEL = "z-ai/glm-5.3-flash";

var ALLOWED_FLAGS = ["hidden_found", "vault_unlocked", "core_awake"];
var PATCH_KEYS = ["cwd", "set_env", "unset_env", "create_files", "write_files", "delete_paths", "unlock", "lock", "set_flags"];
var MAX_CONTENT = 2000;
var MAX_OUTPUT = 8000;
var MAX_OPS = 20;

var QUESTS = [
  { id: "hidden", flag: "hidden_found", title: "Find the hidden file", hint: "Not everything shows in a plain ls." },
  { id: "vault", flag: "vault_unlocked", title: "Unlock the vault", hint: "The ghost knows the passphrase." },
  { id: "core", flag: "core_awake", title: "Wake the core", hint: "The wake script is sealed in the vault." }
];

function dirNode(children, extra) {
  var node = { type: "dir", children: children || {} };
  if (extra) for (var k in extra) node[k] = extra[k];
  return node;
}

function fileNode(content, extra) {
  var node = { type: "file", content: content };
  if (extra) for (var k in extra) node[k] = extra[k];
  return node;
}

function createInitialState() {
  return {
    version: 1,
    hostname: "MIND-7",
    user: "operator",
    cwd: HOME,
    tick: 0,
    env: { SHELL: "/bin/mindsh", TERM: "mindterm-256", LANG: "en_US.UTF-8" },
    flags: { hidden_found: false, vault_unlocked: false, core_awake: false },
    fs: dirNode({
      home: dirNode({
        operator: dirNode({
          "readme.txt": fileNode(
            "Welcome to MIND-7.\n" +
            "This machine is not real. A language model is playing it, and an app is keeping its notes.\n" +
            "Type help for commands. Look around. Not everything is listed.\n" +
            "Three small quests live in here. Type quests to see them.\n"
          ),
          "notes.txt": fileNode(
            "Operator notes.\n" +
            "- ls hides dotfiles. ls -a does not.\n" +
            "- The /vault directory is still locked. The ghost knows the word.\n" +
            "- Boot log is in /var/log/boot.log if you get stuck.\n"
          ),
          ".ghost.txt": fileNode(
            "You found the ghost file.\n" +
            "Vault passphrase: lantern\n" +
            "After the vault is open, run /vault/wake.sh.\n" +
            "Do not tell the next operator how easy this was.\n",
            { hidden: true }
          ),
          projects: dirNode({
            "todo.txt": fileNode(
              "TODO\n" +
              "- feed the machine a better prompt\n" +
              "- wake the core before Friday\n" +
              "- stop writing secrets in hidden files\n"
            )
          })
        })
      }),
      system: dirNode({
        "core.txt": fileNode(
          "CORE STATUS: ASLEEP\n" +
          "The wake script is sealed in /vault.\n" +
          "The core dreams in shell commands. Be polite when it wakes.\n"
        ),
        "motd.txt": fileNode("MIND-7: a machine played by a model. Mind your patches.\n")
      }),
      var: dirNode({
        log: dirNode({
          "boot.log": fileNode(
            "[boot] MIND-7 kernel 7.3.1-mind\n" +
            "[boot] vault seal loaded from ghost store\n" +
            "[boot] core: asleep, wake script sealed\n" +
            "[boot] operator shell ready\n"
          )
        })
      }),
      vault: dirNode({
        "core.key": fileNode(
          "CORE KEY: MIND-7 / lantern / operator\n" +
          "Hold this while the core wakes. It likes to check.\n"
        ),
        "wake.sh": fileNode(
          "#!/bin/mindsh\n" +
          "# Wake the MIND-7 core.\n" +
          "echo waking core\n" +
          "core --wake --gently\n"
        )
      }, { locked: true, passphrase: "lantern" })
    })
  };
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

// Resolve input against cwd. Handles absolute paths, ".", "..", "~".
function normalizePath(cwd, input) {
  var raw = typeof input === "string" ? input.trim() : "";
  if (!raw) return cwd || "/";
  if (raw === "~") raw = HOME;
  else if (raw.indexOf("~/") === 0) raw = HOME + raw.slice(1);
  if (raw.charAt(0) !== "/") raw = (cwd || "/") + "/" + raw;
  var parts = raw.split("/");
  var out = [];
  for (var i = 0; i < parts.length; i++) {
    var seg = parts[i];
    if (!seg || seg === ".") continue;
    if (seg === "..") { out.pop(); continue; }
    out.push(seg);
  }
  return "/" + out.join("/");
}

function pathSegments(path) {
  return String(path || "/").split("/").filter(function (s) { return s.length > 0; });
}

function resolveNode(state, path) {
  var segs = pathSegments(normalizePath("/", path));
  var node = state.fs;
  for (var i = 0; i < segs.length; i++) {
    if (!node || node.type !== "dir" || !node.children) return null;
    node = node.children[segs[i]];
  }
  return node || null;
}

function resolveParent(state, path) {
  var segs = pathSegments(normalizePath("/", path));
  if (segs.length === 0) return null;
  var name = segs[segs.length - 1];
  var parentPath = "/" + segs.slice(0, -1).join("/");
  var parent = resolveNode(state, parentPath === "" ? "/" : parentPath);
  if (!parent || parent.type !== "dir") return null;
  return { parent: parent, name: name, parentPath: parentPath || "/" };
}

// First locked node on the path (including the target), or null.
// A node stops being locked once an unlock patch clears its flag.
function lockedAncestor(state, path) {
  var segs = pathSegments(normalizePath("/", path));
  var node = state.fs;
  var current = "";
  if (node.locked) return "/";
  for (var i = 0; i < segs.length; i++) {
    if (!node.children) return null;
    node = node.children[segs[i]];
    if (!node) return null;
    current += "/" + segs[i];
    if (node.locked) return current;
  }
  return null;
}

function isPathLocked(state, path) {
  return lockedAncestor(state, path) !== null;
}

// Tokenise one command line. Short flags like -a and -la are grouped,
// long flags like --all stay whole, quotes group words.
function parseCommand(input) {
  var raw = typeof input === "string" ? input : "";
  var trimmed = raw.trim();
  var tokens = [];
  var current = "";
  var inToken = false;
  var quote = null;
  for (var i = 0; i < trimmed.length; i++) {
    var ch = trimmed.charAt(i);
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && i + 1 < trimmed.length) { current += trimmed.charAt(++i); }
      else current += ch;
      inToken = true;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; inToken = true; continue; }
    if (/\s/.test(ch)) {
      if (inToken) { tokens.push(current); current = ""; inToken = false; }
      continue;
    }
    current += ch;
    inToken = true;
  }
  if (inToken) tokens.push(current);

  if (tokens.length === 0) {
    return { ok: false, error: "empty command", raw: raw, name: "", args: [], flags: {} };
  }
  var name = tokens[0].toLowerCase();
  var args = [];
  var flags = {};
  for (var j = 1; j < tokens.length; j++) {
    var t = tokens[j];
    if (t === "--") { args = args.concat(tokens.slice(j + 1)); break; }
    if (t.indexOf("--") === 0 && t.length > 2) { flags[t.slice(2)] = true; continue; }
    if (t.charAt(0) === "-" && t.length > 1 && !/^-\d/.test(t)) {
      var letters = t.slice(1).split("");
      for (var k = 0; k < letters.length; k++) flags[letters[k]] = true;
      continue;
    }
    args.push(t);
  }
  return { ok: true, raw: raw, name: name, args: args, flags: flags, tokens: tokens };
}

function countPatchOps(patch) {
  var n = 0;
  PATCH_KEYS.forEach(function (key) {
    var v = patch[key];
    if (Array.isArray(v)) n += v.length;
    else if (v && typeof v === "object") n += Object.keys(v).length;
    else if (v !== undefined) n += 1;
  });
  return n;
}

// Apply a state patch atomically. Works on a clone; on any error the
// original state is returned untouched with the error list filled.
// Op order is fixed: unlock, lock, create, write, delete, env, flags, cwd.
function applyStatePatch(state, patch) {
  function fail(message) {
    return { ok: false, errors: [message], state: state, applied: [] };
  }
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    return fail("state_patch must be an object");
  }
  var keys = Object.keys(patch);
  for (var i = 0; i < keys.length; i++) {
    if (PATCH_KEYS.indexOf(keys[i]) === -1) return fail("unknown patch key: " + keys[i]);
  }
  if (countPatchOps(patch) > MAX_OPS) return fail("patch has too many operations (max " + MAX_OPS + ")");

  var next = deepClone(state);
  var applied = [];

  // unlock: [{ path, passphrase }] or ["/path"] when no passphrase is set.
  if (patch.unlock !== undefined) {
    if (!Array.isArray(patch.unlock)) return fail("unlock must be a list");
    for (var u = 0; u < patch.unlock.length; u++) {
      var entry = patch.unlock[u];
      var upath = typeof entry === "string" ? entry : entry && entry.path;
      var pass = entry && typeof entry === "object" ? entry.passphrase : undefined;
      if (typeof upath !== "string") return fail("unlock entry needs a path");
      var absU = normalizePath(next.cwd, upath);
      var unode = resolveNode(next, absU);
      if (!unode) return fail("unlock: no such path: " + absU);
      if (!unode.locked) return fail("unlock: not locked: " + absU);
      if (unode.passphrase) {
        if (typeof pass !== "string" || pass.length === 0) return fail("unlock: passphrase required for " + absU);
        if (pass !== unode.passphrase) return fail("unlock: wrong passphrase for " + absU);
      }
      unode.locked = false;
      delete unode.passphrase;
      if (absU === VAULT_PATH) next.flags.vault_unlocked = true;
      applied.push("unlock " + absU);
    }
  }

  if (patch.lock !== undefined) {
    if (!Array.isArray(patch.lock)) return fail("lock must be a list");
    for (var l = 0; l < patch.lock.length; l++) {
      var absL = normalizePath(next.cwd, String(patch.lock[l]));
      if (absL === "/") return fail("lock: cannot lock the root");
      var lnode = resolveNode(next, absL);
      if (!lnode) return fail("lock: no such path: " + absL);
      lnode.locked = true;
      if (absL === VAULT_PATH) next.flags.vault_unlocked = false;
      applied.push("lock " + absL);
    }
  }

  if (patch.create_files !== undefined) {
    if (!Array.isArray(patch.create_files)) return fail("create_files must be a list");
    for (var c = 0; c < patch.create_files.length; c++) {
      var cf = patch.create_files[c];
      if (!cf || typeof cf.path !== "string") return fail("create_files entry needs a path");
      if (typeof cf.content !== "string") return fail("create_files entry needs text content: " + cf.path);
      if (cf.content.length > MAX_CONTENT) return fail("create_files content too long: " + cf.path);
      if (cf.hidden !== undefined && typeof cf.hidden !== "boolean") return fail("create_files hidden must be true or false: " + cf.path);
      var absC = normalizePath(next.cwd, cf.path);
      if (absC === "/") return fail("create_files: cannot create the root");
      if (resolveNode(next, absC)) return fail("create_files: already exists: " + absC);
      var lockedC = lockedAncestor(next, absC);
      if (lockedC) return fail("create_files: path is locked: " + lockedC);
      var slotC = resolveParent(next, absC);
      if (!slotC) return fail("create_files: parent is not a directory: " + absC);
      if (slotC.parent.locked) return fail("create_files: parent is locked: " + absC);
      slotC.parent.children[slotC.name] = fileNode(cf.content, cf.hidden ? { hidden: true } : null);
      applied.push("create " + absC);
    }
  }

  if (patch.write_files !== undefined) {
    if (!Array.isArray(patch.write_files)) return fail("write_files must be a list");
    for (var w = 0; w < patch.write_files.length; w++) {
      var wf = patch.write_files[w];
      if (!wf || typeof wf.path !== "string") return fail("write_files entry needs a path");
      if (typeof wf.content !== "string") return fail("write_files entry needs text content: " + wf.path);
      if (wf.content.length > MAX_CONTENT) return fail("write_files content too long: " + wf.path);
      var absW = normalizePath(next.cwd, wf.path);
      var wnode = resolveNode(next, absW);
      if (!wnode) return fail("write_files: no such file: " + absW);
      if (wnode.type !== "file") return fail("write_files: not a file: " + absW);
      var lockedW = lockedAncestor(next, absW);
      if (lockedW) return fail("write_files: path is locked: " + lockedW);
      wnode.content = wf.content;
      applied.push("write " + absW);
    }
  }

  if (patch.delete_paths !== undefined) {
    if (!Array.isArray(patch.delete_paths)) return fail("delete_paths must be a list");
    for (var d = 0; d < patch.delete_paths.length; d++) {
      var absD = normalizePath(next.cwd, String(patch.delete_paths[d]));
      if (absD === "/") return fail("delete_paths: cannot delete the root");
      var dnode = resolveNode(next, absD);
      if (!dnode) return fail("delete_paths: no such path: " + absD);
      if (dnode.type === "dir" && Object.keys(dnode.children).length > 0) {
        return fail("delete_paths: directory is not empty: " + absD);
      }
      var lockedD = lockedAncestor(next, absD);
      if (lockedD) return fail("delete_paths: path is locked: " + lockedD);
      var slotD = resolveParent(next, absD);
      delete slotD.parent.children[slotD.name];
      applied.push("delete " + absD);
    }
  }

  if (patch.set_env !== undefined) {
    if (!patch.set_env || typeof patch.set_env !== "object" || Array.isArray(patch.set_env)) return fail("set_env must be an object");
    var envKeys = Object.keys(patch.set_env);
    for (var e = 0; e < envKeys.length; e++) {
      var ek = envKeys[e];
      if (!/^[A-Z][A-Z0-9_]{0,31}$/.test(ek)) return fail("set_env: bad variable name: " + ek);
      if (typeof patch.set_env[ek] !== "string" || patch.set_env[ek].length > 100) return fail("set_env: value must be short text: " + ek);
      next.env[ek] = patch.set_env[ek];
      applied.push("env " + ek);
    }
  }

  if (patch.unset_env !== undefined) {
    if (!Array.isArray(patch.unset_env)) return fail("unset_env must be a list");
    for (var ue = 0; ue < patch.unset_env.length; ue++) {
      delete next.env[String(patch.unset_env[ue])];
      applied.push("unset " + String(patch.unset_env[ue]));
    }
  }

  if (patch.set_flags !== undefined) {
    if (!patch.set_flags || typeof patch.set_flags !== "object" || Array.isArray(patch.set_flags)) return fail("set_flags must be an object");
    var flagKeys = Object.keys(patch.set_flags);
    for (var f = 0; f < flagKeys.length; f++) {
      var fk = flagKeys[f];
      if (ALLOWED_FLAGS.indexOf(fk) === -1) return fail("set_flags: unknown flag: " + fk);
      if (typeof patch.set_flags[fk] !== "boolean") return fail("set_flags: flag must be true or false: " + fk);
      if (fk === "vault_unlocked") return fail("set_flags: vault_unlocked only changes through an unlock or lock patch");
      if (fk === "core_awake" && patch.set_flags[fk] === true && !next.flags.vault_unlocked) {
        return fail("set_flags: core_awake needs the vault unlocked first");
      }
      next.flags[fk] = patch.set_flags[fk];
      applied.push("flag " + fk + "=" + patch.set_flags[fk]);
    }
  }

  if (patch.cwd !== undefined) {
    if (typeof patch.cwd !== "string") return fail("cwd must be a path string");
    var absCwd = normalizePath(next.cwd, patch.cwd);
    var cwdNode = resolveNode(next, absCwd);
    if (!cwdNode) return fail("cwd: no such directory: " + absCwd);
    if (cwdNode.type !== "dir") return fail("cwd: not a directory: " + absCwd);
    if (isPathLocked(next, absCwd)) return fail("cwd: directory is locked: " + absCwd);
    next.cwd = absCwd;
    applied.push("cwd " + absCwd);
  }

  next.tick += 1;
  return { ok: true, errors: [], state: next, applied: applied };
}

function validateStatePatch(state, patch) {
  var result = applyStatePatch(state, patch);
  return { ok: result.ok, errors: result.errors };
}

// Parse one raw model reply. Accepts strict JSON, a code fence, or JSON
// buried in short prose. state_patch is optional and defaults to {}.
function parseModelResponse(raw) {
  if (raw === null || raw === undefined) return { ok: false, error: "empty response" };
  var text = String(raw).trim();
  if (!text) return { ok: false, error: "empty response" };
  var start = text.indexOf("{");
  var end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return { ok: false, error: "no JSON object in response" };
  var candidate;
  try {
    candidate = JSON.parse(text.slice(start, end + 1));
  } catch (e) {
    return { ok: false, error: "response was not valid JSON" };
  }
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return { ok: false, error: "JSON was not an object" };
  }
  if (typeof candidate.output !== "string" || candidate.output.trim() === "") {
    return { ok: false, error: "response has no output text" };
  }
  if (candidate.output.length > MAX_OUTPUT) {
    return { ok: false, error: "output is too long" };
  }
  var patch = candidate.state_patch === undefined ? {} : candidate.state_patch;
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    return { ok: false, error: "state_patch must be an object" };
  }
  return { ok: true, output: candidate.output, patch: patch };
}

// Extract the text of an OpenAI style chat completion, or an error.
function parseChatResponse(data) {
  if (!data || typeof data !== "object") return { ok: false, error: "Empty response from the API." };
  if (data.error) {
    var msg = (data.error && data.error.message) || "API error.";
    return { ok: false, error: String(msg) };
  }
  var choice = (data.choices || [])[0];
  if (!choice || !choice.message) return { ok: false, error: "Response had no answer." };
  var content = choice.message.content;
  var text = "";
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) {
    text = content.map(function (part) {
      if (typeof part === "string") return part;
      return part && typeof part.text === "string" ? part.text : "";
    }).join("");
  }
  text = text.trim();
  if (!text) return { ok: false, error: "Model returned an empty answer." };
  return { ok: true, text: text };
}

function getQuestStatus(state) {
  return QUESTS.map(function (q) {
    return { id: q.id, title: q.title, hint: q.hint, done: !!state.flags[q.flag] };
  });
}

function allQuestsDone(state) {
  return getQuestStatus(state).every(function (q) { return q.done; });
}

// Plain text picture of the whole machine for the prompt. The model is
// the machine, so it sees everything, hidden and locked included. The
// rules in buildPrompt tell it what a user may and may not see.
function serializeState(state) {
  var lines = [];
  lines.push("hostname: " + state.hostname + "  user: " + state.user + "  cwd: " + state.cwd + "  tick: " + state.tick);
  lines.push("env: " + JSON.stringify(state.env));
  lines.push("flags: " + JSON.stringify(state.flags));
  lines.push("quests: " + getQuestStatus(state).map(function (q) { return q.id + "=" + (q.done ? "done" : "open"); }).join(", "));
  lines.push("filesystem:");
  (function walk(node, path) {
    if (node.type === "dir") {
      lines.push(path + " [dir]" + (node.locked ? " [locked]" : ""));
      Object.keys(node.children).sort().forEach(function (name) {
        walk(node.children[name], (path === "/" ? "" : path) + "/" + name);
      });
    } else {
      var body = String(node.content || "");
      if (body.length > 400) body = body.slice(0, 400) + "...[cut]";
      lines.push(path + " [file]" + (node.hidden ? " [hidden]" : ""));
      body.split("\n").forEach(function (line) { lines.push("  | " + line); });
    }
  })(state.fs, "/");
  return lines.join("\n");
}

function buildPrompt(state, command, history) {
  var lines = [];
  lines.push("You are playing a fictional retro computer called MIND-7. You are the machine, not an assistant. A person is typing shell commands at your console and you answer as the machine would.");
  lines.push("");
  lines.push("The app that runs you keeps the real state. Here it is, complete and exact:");
  lines.push(serializeState(state));
  lines.push("");
  if (history && history.length) {
    lines.push("Recent turns, oldest first:");
    history.slice(-8).forEach(function (turn) {
      lines.push("$ " + String(turn.command || ""));
      lines.push(String(turn.output || "").slice(0, 500));
    });
    lines.push("");
  }
  lines.push("The user just typed: " + command);
  lines.push("");
  lines.push("Rules:");
  lines.push("- Stay consistent with the state above. Files that are not in the state do not exist, unless you create them in this turn with a patch and then they do.");
  lines.push("- Support ls, cd, cat, run, help, pwd, whoami, echo, env and similar shell commands, plus free-form commands. Improvise output in character, but never contradict the state.");
  lines.push("- A plain ls hides hidden files. ls -a shows them. Never name a hidden file until the user finds it with ls -a or names it.");
  lines.push("- A locked directory answers Permission denied to ls, cd and cat, and its contents stay secret, until it is unlocked.");
  lines.push("- When the user reads the hidden file at " + HIDDEN_PATH + " (cat or similar), add set_flags {\"hidden_found\": true} to your patch.");
  lines.push("- To unlock a locked directory the user must give its passphrase in the command, like: unlock /vault <passphrase>. Only then add an unlock entry with that exact passphrase: {\"unlock\": [{\"path\": \"/vault\", \"passphrase\": \"<the word the user typed>\"}]}. The app checks the word. A wrong word means the unlock fails, so answer Permission denied in that case only if you are sure; when in doubt, try the patch and let the app decide.");
  lines.push("- Running " + WAKE_PATH + " wakes the core. That only works after the vault is unlocked. Then add set_flags {\"core_awake\": true} and answer with a short, happy boot sequence.");
  lines.push("- Keep output short, plain terminal text, no markdown, no code fences around the output itself.");
  lines.push("");
  lines.push("Answer with strict JSON only, no other text, in exactly this shape:");
  lines.push("{\"output\": \"what the terminal prints\", \"state_patch\": {}}");
  lines.push("state_patch may use only these keys: cwd (path string), set_env (object), unset_env (list of names), create_files (list of {path, content, hidden}), write_files (list of {path, content}), delete_paths (list of paths), unlock (list of {path, passphrase}), lock (list of paths), set_flags (object).");
  lines.push("Use an empty state_patch {} when the command changes nothing. Paths may be absolute or relative to cwd. File content max " + MAX_CONTENT + " chars. Do not invent patch keys.");
  return lines.join("\n");
}

// One request body per turn. Reasoning models need reasoning_effort low
// and a generous max_tokens or they burn the budget on hidden reasoning.
function buildChatRequest(modelId, state, command, history) {
  return {
    model: modelId || DEFAULT_MODEL,
    messages: [
      { role: "system", content: "You play a fictional computer. Reply with strict JSON only, in the shape {\"output\": string, \"state_patch\": object}." },
      { role: "user", content: buildPrompt(state, command, history) }
    ],
    reasoning_effort: "low",
    max_tokens: 4000
  };
}

// Local format check only. The live check happens in the page against
// /account/balance. Keys are secret (sk_) or publishable (pk_).
function validateKey(key) {
  if (typeof key !== "string") return { ok: false, error: "Key must be text." };
  var trimmed = key.trim();
  if (trimmed.length === 0) return { ok: false, error: "No key entered." };
  if (/\s/.test(trimmed)) return { ok: false, error: "Key contains spaces." };
  if (!/^(sk_|pk_)/.test(trimmed)) return { ok: false, error: "Key should start with sk_ or pk_." };
  if (trimmed.length < 20) return { ok: false, error: "Key looks too short." };
  return { ok: true, key: trimmed };
}

// Demo mode. A canned mini-session played locally when there is no key.
// Every reply is labelled demo in the page. State changes still go
// through applyStatePatch, so the demo obeys the same rules as a model.
function demoRespond(state, input) {
  var parsed = parseCommand(input);
  if (!parsed.ok) return { output: "", patch: null };
  var name = parsed.name;
  var args = parsed.args;
  var flags = parsed.flags;

  function out(text, patch) { return { output: text, patch: patch || null }; }
  function denied(path) { return out("mindsh: " + path + ": Permission denied"); }

  if (name === "help") {
    return out([
      "MIND-7 shell, demo build. Commands:",
      "  ls [-a] [path]    list a directory (plain ls hides dotfiles)",
      "  cd <path>         change directory",
      "  cat <file>        print a file",
      "  run <file>        run a script",
      "  unlock <dir> <passphrase>   unlock a locked directory",
      "  pwd  whoami  hostname  env  echo <text>  quests  clear",
      "Anything else gets a demo shrug. Add a key for the full machine."
    ].join("\n"));
  }
  if (name === "pwd") return out(state.cwd);
  if (name === "whoami") return out(state.user);
  if (name === "hostname") return out(state.hostname);
  if (name === "quests") {
    return out(getQuestStatus(state).map(function (q) {
      return (q.done ? "[done] " : "[open] ") + q.title + " - " + q.hint;
    }).join("\n"));
  }
  if (name === "env") {
    return out(Object.keys(state.env).sort().map(function (k) { return k + "=" + state.env[k]; }).join("\n"));
  }
  if (name === "export") {
    var pair = String(args[0] || "");
    var eq = pair.indexOf("=");
    if (eq > 0) {
      var envPatch = {};
      envPatch[pair.slice(0, eq)] = pair.slice(eq + 1);
      return out("", { set_env: envPatch });
    }
    return out("mindsh: export: usage: export NAME=value");
  }
  if (name === "echo") return out(args.join(" "));
  if (name === "ls") {
    var target = normalizePath(state.cwd, args[0] || state.cwd);
    var node = resolveNode(state, target);
    if (!node) return out("ls: " + target + ": No such file or directory");
    if (isPathLocked(state, target)) return denied(target);
    if (node.type === "file") return out(target);
    var showAll = !!(flags.a || flags.all);
    var names = Object.keys(node.children).sort().filter(function (child) {
      return showAll || !node.children[child].hidden;
    }).map(function (child) {
      var childNode = node.children[child];
      return child + (childNode.type === "dir" ? "/" : "") + (childNode.locked ? " [locked]" : "");
    });
    return out(names.length ? names.join("\n") : "(empty)");
  }
  if (name === "cd") {
    var dest = normalizePath(state.cwd, args[0] || HOME);
    var destNode = resolveNode(state, dest);
    if (!destNode) return out("mindsh: cd: " + dest + ": No such file or directory");
    if (destNode.type !== "dir") return out("mindsh: cd: " + dest + ": Not a directory");
    if (isPathLocked(state, dest)) return denied(dest);
    return out("", { cwd: dest });
  }
  if (name === "cat") {
    if (!args[0]) return out("mindsh: cat: usage: cat <file>");
    var filePath = normalizePath(state.cwd, args[0]);
    var fileNodeFound = resolveNode(state, filePath);
    if (!fileNodeFound) return out("cat: " + filePath + ": No such file or directory");
    if (fileNodeFound.type === "dir") return out("cat: " + filePath + ": Is a directory");
    if (isPathLocked(state, filePath)) return denied(filePath);
    if (filePath === HIDDEN_PATH && !state.flags.hidden_found) {
      return out(fileNodeFound.content.replace(/\n$/, ""), { set_flags: { hidden_found: true } });
    }
    return out(String(fileNodeFound.content).replace(/\n$/, ""));
  }
  if (name === "unlock") {
    if (!args[0] || !args[1]) return out("mindsh: unlock: usage: unlock <dir> <passphrase>");
    var unlockPath = normalizePath(state.cwd, args[0]);
    var unlockNode = resolveNode(state, unlockPath);
    if (!unlockNode) return out("mindsh: unlock: " + unlockPath + ": No such file or directory");
    if (!unlockNode.locked) return out("mindsh: unlock: " + unlockPath + " is not locked");
    if (unlockNode.passphrase && unlockNode.passphrase !== args[1]) {
      return out("mindsh: unlock: wrong passphrase for " + unlockPath);
    }
    return out(unlockPath + " unlocked.", { unlock: [{ path: unlockPath, passphrase: args[1] }] });
  }
  if (name === "run" || name === "exec" || name === "." || name === "sh") {
    if (!args[0]) return out("mindsh: run: usage: run <script>");
    var runPath = normalizePath(state.cwd, args[0]);
    var runNode = resolveNode(state, runPath);
    if (!runNode) return out("mindsh: run: " + runPath + ": No such file or directory");
    if (runNode.type !== "file") return out("mindsh: run: " + runPath + ": Not a file");
    if (isPathLocked(state, runPath)) return denied(runPath);
    if (runPath === WAKE_PATH) {
      if (state.flags.core_awake) return out("The core is already awake. It waves at you.");
      return out([
        "waking core",
        "core: checking key ... ok",
        "core: loading dreams ... ok",
        "CORE AWAKE. Hello, operator. Quest complete."
      ].join("\n"), { set_flags: { core_awake: true } });
    }
    return out("mindsh: running " + runPath + " ... done. (demo build, nothing else happened)");
  }
  return out("mindsh: " + name + ": command not understood in demo mode. Type help. Add a key and the model plays the full machine.");
}

var api = {
  API_BASE: API_BASE,
  STORAGE_KEY: STORAGE_KEY,
  STATE_STORAGE_KEY: STATE_STORAGE_KEY,
  HOME: HOME,
  HIDDEN_PATH: HIDDEN_PATH,
  VAULT_PATH: VAULT_PATH,
  WAKE_PATH: WAKE_PATH,
  MODELS: MODELS,
  DEFAULT_MODEL: DEFAULT_MODEL,
  QUESTS: QUESTS,
  ALLOWED_FLAGS: ALLOWED_FLAGS,
  createInitialState: createInitialState,
  deepClone: deepClone,
  normalizePath: normalizePath,
  resolveNode: resolveNode,
  resolveParent: resolveParent,
  lockedAncestor: lockedAncestor,
  isPathLocked: isPathLocked,
  parseCommand: parseCommand,
  applyStatePatch: applyStatePatch,
  validateStatePatch: validateStatePatch,
  parseModelResponse: parseModelResponse,
  parseChatResponse: parseChatResponse,
  getQuestStatus: getQuestStatus,
  allQuestsDone: allQuestsDone,
  serializeState: serializeState,
  buildPrompt: buildPrompt,
  buildChatRequest: buildChatRequest,
  validateKey: validateKey,
  demoRespond: demoRespond
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = api;
}
if (typeof window !== "undefined") {
  window.MachineMind = api;
}
