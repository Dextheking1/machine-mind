"use strict";

// Page layer for Machine Mind. Network and DOM live here, all rules
// live in core.js (window.MachineMind).

(function () {
  var Core = window.MachineMind;

  var els = {};
  ["modeBadge", "keyStatus", "demoBanner", "screen", "commandForm", "commandInput",
   "promptText", "sendBtn", "keyInput", "validateKeyBtn", "clearKeyBtn", "keyMessage",
   "modelSelect", "customModel", "stateCwd", "stateTick", "questList", "winBanner",
   "treeView", "resetBtn"].forEach(function (id) { els[id] = document.getElementById(id); });

  var state = loadState();
  var history = [];
  var lastCommand = "";
  var busy = false;

  Core.MODELS.forEach(function (m) {
    var opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = m.label;
    if (m.id === Core.DEFAULT_MODEL) opt.selected = true;
    els.modelSelect.appendChild(opt);
  });

  function loadState() {
    try {
      var raw = localStorage.getItem(Core.STATE_STORAGE_KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && parsed.fs && parsed.cwd && parsed.flags) return parsed;
      }
    } catch (e) { /* fall through to a fresh machine */ }
    return Core.createInitialState();
  }

  function saveState() {
    try { localStorage.setItem(Core.STATE_STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* private mode */ }
  }

  function getKey() {
    try { return localStorage.getItem(Core.STORAGE_KEY) || ""; } catch (e) { return ""; }
  }

  function setKey(key) {
    try {
      if (key) localStorage.setItem(Core.STORAGE_KEY, key);
      else localStorage.removeItem(Core.STORAGE_KEY);
    } catch (e) { /* private mode */ }
    renderKeyState();
  }

  function selectedModel() {
    var custom = els.customModel.value.trim();
    return custom || els.modelSelect.value || Core.DEFAULT_MODEL;
  }

  function print(text, cls) {
    var div = document.createElement("div");
    div.className = "turn" + (cls ? " " + cls : "");
    div.textContent = text;
    els.screen.appendChild(div);
    els.screen.scrollTop = els.screen.scrollHeight;
  }

  function printCommand(command) {
    var div = document.createElement("div");
    div.className = "turn cmd";
    div.textContent = promptLabel() + " " + command;
    els.screen.appendChild(div);
    els.screen.scrollTop = els.screen.scrollHeight;
  }

  function promptLabel() {
    var cwd = state.cwd === Core.HOME ? "~" : state.cwd;
    return state.user + "@" + state.hostname + ":" + cwd + "$";
  }

  // Visible tree for the side panel: hidden files stay hidden and a
  // locked directory shows no contents, same as the user sees in ls.
  function treeLines() {
    var lines = [];
    (function walk(node, path, depth) {
      var label = path === "/" ? "/" : path.split("/").pop();
      var suffix = node.type === "dir" ? "/" : "";
      lines.push(new Array(depth + 1).join("  ") + label + suffix + (node.locked ? " [locked]" : ""));
      if (node.type !== "dir" || node.locked) return;
      Object.keys(node.children).sort().forEach(function (name) {
        var child = node.children[name];
        if (child.hidden) return;
        walk(child, (path === "/" ? "" : path) + "/" + name, depth + 1);
      });
    })(state.fs, "/", 0);
    return lines.join("\n");
  }

  function renderState() {
    els.stateCwd.textContent = state.cwd;
    els.stateTick.textContent = String(state.tick);
    els.promptText.textContent = promptLabel();
    els.treeView.textContent = treeLines();
    els.questList.innerHTML = "";
    Core.getQuestStatus(state).forEach(function (q) {
      var li = document.createElement("li");
      if (q.done) li.className = "done";
      li.textContent = (q.done ? "[done] " : "[open] ") + q.title;
      var hint = document.createElement("span");
      hint.className = "quest-hint";
      hint.textContent = q.hint;
      li.appendChild(hint);
      els.questList.appendChild(li);
    });
    els.winBanner.hidden = !Core.allQuestsDone(state);
  }

  function renderKeyState() {
    var key = getKey();
    var live = !!key;
    els.modeBadge.textContent = live ? "Live mode - a model plays the machine" : "Demo mode - canned session";
    els.modeBadge.className = "badge " + (live ? "badge-live" : "badge-demo");
    els.keyStatus.textContent = live ? "Key set" : "No key set";
    els.demoBanner.hidden = live;
    if (live && !els.keyInput.value) els.keyInput.value = key;
  }

  function setKeyMessage(text, ok) {
    els.keyMessage.textContent = text;
    els.keyMessage.className = "key-message " + (ok ? "ok" : "bad");
  }

  async function validateKeyLive() {
    var check = Core.validateKey(els.keyInput.value);
    if (!check.ok) { setKeyMessage(check.error, false); return; }
    setKeyMessage("Checking key...", true);
    try {
      var res = await fetch(Core.API_BASE + "/account/balance", {
        headers: { Authorization: "Bearer " + check.key }
      });
      var data = await res.json().catch(function () { return null; });
      if (!res.ok) {
        var msg = (data && data.error && data.error.message) || ("HTTP " + res.status);
        setKeyMessage("Key rejected: " + msg, false);
        return;
      }
      setKey(check.key);
      var balance = data && (data.balance !== undefined ? data.balance : (data.accountBalance && data.accountBalance.total));
      setKeyMessage("Key works. Balance: " + (balance !== undefined && balance !== null ? balance + " Pollen." : "unknown."), true);
      print("Key set. A model now plays the machine. Type help.", "sys");
    } catch (e) {
      setKeyMessage("Network error while checking the key.", false);
    }
  }

  function applyPatch(patch) {
    if (!patch || Object.keys(patch).length === 0) return;
    var result = Core.applyStatePatch(state, patch);
    if (result.ok) {
      state = result.state;
      saveState();
      renderState();
    } else {
      print("[app] state patch rejected, nothing changed: " + result.errors.join("; "), "err");
    }
  }

  function finishTurn(command, output, patch) {
    if (output) print(output);
    if (patch) applyPatch(patch);
    history.push({ command: command, output: output || "" });
    if (Core.allQuestsDone(state)) print("All quests complete. The core is awake.", "sys");
  }

  async function callModel(command) {
    var key = getKey();
    var request = Core.buildChatRequest(selectedModel(), state, command, history);
    var res = await fetch(Core.API_BASE + "/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify(request)
    });
    var data = await res.json().catch(function () { return null; });
    if (!res.ok) {
      var msg = (data && data.error && data.error.message) || ("HTTP " + res.status);
      throw new Error(msg);
    }
    var parsedText = Core.parseChatResponse(data);
    if (!parsedText.ok) throw new Error(parsedText.error);
    var parsed = Core.parseModelResponse(parsedText.text);
    if (parsed.ok) return parsed;
    // One retry: models sometimes wrap the JSON or trail off. Ask once
    // more for strict JSON only, then give up for this turn.
    var retryRequest = Core.buildChatRequest(selectedModel(), state, command, history.concat([
      { command: command, output: "[your last answer was not valid strict JSON: " + parsed.error + ". Answer again with strict JSON only.]" }
    ]));
    var res2 = await fetch(Core.API_BASE + "/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify(retryRequest)
    });
    var data2 = await res2.json().catch(function () { return null; });
    if (!res2.ok) {
      var msg2 = (data2 && data2.error && data2.error.message) || ("HTTP " + res2.status);
      throw new Error(msg2);
    }
    var parsedText2 = Core.parseChatResponse(data2);
    if (!parsedText2.ok) throw new Error(parsedText2.error);
    var parsed2 = Core.parseModelResponse(parsedText2.text);
    if (!parsed2.ok) {
      print("[app] the model did not answer in the JSON shape. Raw answer follows, state unchanged.", "err");
      print(parsedText2.text, "sys");
      return { output: "", patch: null };
    }
    return parsed2;
  }

  async function runCommand(rawInput) {
    var command = String(rawInput || "").trim();
    if (!command || busy) return;
    lastCommand = command;
    printCommand(command);

    if (command === "clear") { els.screen.innerHTML = ""; return; }
    if (command === "reset") { reboot(); return; }

    if (!getKey()) {
      var demo = Core.demoRespond(state, command);
      finishTurn(command, demo.output, demo.patch);
      return;
    }

    busy = true;
    els.sendBtn.disabled = true;
    els.commandInput.disabled = true;
    try {
      var result = await callModel(command);
      finishTurn(command, result.output, result.patch);
    } catch (e) {
      print("Error: " + e.message, "err");
    } finally {
      busy = false;
      els.sendBtn.disabled = false;
      els.commandInput.disabled = false;
      els.commandInput.focus();
    }
  }

  function reboot() {
    state = Core.createInitialState();
    history = [];
    saveState();
    renderState();
    print("MIND-7 rebooted. Fresh machine, quests reset. Type help.", "sys");
  }

  els.commandForm.addEventListener("submit", function (ev) {
    ev.preventDefault();
    var value = els.commandInput.value;
    els.commandInput.value = "";
    runCommand(value);
  });

  els.commandInput.addEventListener("keydown", function (ev) {
    if (ev.key === "ArrowUp" && lastCommand) {
      ev.preventDefault();
      els.commandInput.value = lastCommand;
    }
  });

  els.validateKeyBtn.addEventListener("click", validateKeyLive);
  els.clearKeyBtn.addEventListener("click", function () {
    els.keyInput.value = "";
    setKey("");
    setKeyMessage("Key cleared. Demo mode.", true);
  });
  els.resetBtn.addEventListener("click", reboot);
  els.screen.addEventListener("click", function () { els.commandInput.focus(); });

  renderKeyState();
  renderState();
  print("MIND-7 (build 7.3.1) console ready.", "sys");
  print("A model plays this machine. The app keeps its state honest.\nType help to start. Three quests are hidden in here: type quests.", "sys");
  if (!getKey()) print("Demo mode: canned session, no key, no cost. Paste a key on the right for the full machine.", "sys");
  els.commandInput.focus();
})();
