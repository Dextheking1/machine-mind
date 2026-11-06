# Machine Mind

A fake retro terminal where a Pollinations model plays the machine.

Quest: pollinations/pollinations #19179, "An app or game where a model plays a machine" (10 Pollen, best submission wins).

## What it is

You type shell commands at a console for a fictional computer called MIND-7. There is no real shell behind it. A language model plays the machine: it answers `ls`, `cd`, `cat`, `run`, `help` and anything else you invent, in character, as the operating system.

The trick that keeps it honest is state. The app keeps a real state object in the browser:

- a filesystem tree with files, hidden files and one locked directory
- current directory, environment variables, a tick counter
- quest progress flags

Every turn, the whole state goes into the prompt. The model answers with strict JSON, `{"output": "...", "state_patch": {...}}`. The app validates the patch against fixed rules and only then applies it. A patch that breaks the rules (create over an existing file, enter a locked directory, set a flag it has not earned, wrong vault passphrase, unknown patch keys) is rejected whole and nothing changes. The model can improvise the words. It cannot improvise the facts.

## Quests inside the machine

Three small quests live in the fiction, tracked in the side panel:

1. Find the hidden file. Plain `ls` hides dotfiles.
2. Unlock the vault. The hidden file knows the passphrase, and the app itself checks the word, not just the model.
3. Wake the core. The wake script is sealed in the vault, and the `core_awake` flag cannot be set before the vault is open.

The state persists in localStorage between visits. `reset` or the reboot button starts a fresh machine.

## BYOP

Bring your own Pollen. Paste a Pollinations key (`sk_...`) in the page:

- the key is stored only in your browser, in localStorage
- requests go only to `gen.pollinations.ai`, `POST /v1/chat/completions` for the machine turns and `GET /account/balance` to validate the key
- pick the model that plays the machine, or type a custom model id
- default model is `z-ai/glm-5.3-flash`. Requests set `reasoning_effort: "low"` and a generous `max_tokens`, because reasoning models otherwise burn the token budget on hidden reasoning and error out
- one command costs one small chat call

No key? The app runs in demo mode: a clearly labelled canned mini-session played locally, with the same filesystem, the same validation rules and the same three quests. It is a taste, not the full machine. With a key the model improvises everything, including files it creates through patches and commands nobody scripted.

## Run it

Static site, no build step. Serve the folder any way you like:

```
python3 -m http.server 8000
```

Then open http://localhost:8000.

## Files

- `index.html` - the page
- `styles.css` - retro terminal styling
- `core.js` - all rules: state, patch validation, command parsing, prompt building, demo session. Runs in the browser and in node
- `app.js` - DOM and network only
- `tests/core.test.js` - node tests for the core logic

## Tests

```
npm test
```

35 tests: command parsing (quotes, flags, `--`), path normalising, patch application and validation (create, write, delete, cwd, env, unlock passphrase checks, flag gating, atomic rejection), model response parsing, key format, prompt building, and the full demo quest chain from hidden file to awake core.
