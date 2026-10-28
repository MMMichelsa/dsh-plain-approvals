# Changelog

## 1.1.0

**Install fix — why this release exists.** Every documented install command pointed at
`--profile web`. The desktop client loads the `desktop` profile, so anyone following the README
installed the plugin somewhere the desktop build could never see it: "installed, but nothing
happens". All docs, the bundle-patch comment and the release notes now say `desktop`.

### One-click install (new)

- `install.bat` (Windows, double-click) and `install.mjs` (any platform, `node install.mjs`).
- Finds Node by itself: PATH, the usual install dirs (nodejs / nvm / scoop / Volta) and the runtime
  bundled with the DSH desktop app — no environment variables to configure first.
- Finds the DSH CLI by itself: `--dsh`, `DSH_CLI`, PATH, then the desktop install dir.
- Chinese prompts that cannot mojibake: the `.bat` is pure ASCII and receives its Chinese text via
  PowerShell `-EncodedCommand` (UTF-16LE base64), so the console code page cannot mangle it.
- Paths with spaces or non-ASCII characters are fine: the child runs through `cmd.exe` with
  `windowsVerbatimArguments` and explicit quoting.
- Falls back on its own: pinned `github:` tag → tarball (no `git` needed) → `main` tarball →
  local `link:`. Each attempt is verified against the profile manifest and `node_modules`.
- Backs up `package.json` and `pnpm-lock.yaml` (timestamped) before touching anything.

### Nested commands (`bash -c`, `python -c`, `pwsh -Command`, `-EncodedCommand`)

- A command that wraps another script no longer hides its payload: shell / `cmd` / PowerShell /
  Python / Node wrappers are unwrapped and the inner script is classified again; the worst verdict wins.
- `powershell -EncodedCommand <base64>` is decoded (UTF-16LE) before inspection.
- Bounded on purpose: 3 levels deep, 4000 characters of inner script, 24 expansions, and a
  20 000-character cap on the command itself. When a budget runs out the card says so instead of
  pretending it saw everything — infinite nesting cannot hang the host.
- Flags that take no value (`-NoProfile`) no longer swallow the next flag, so
  `pwsh -NoProfile -ExecutionPolicy Bypass -Command …` is still recognised.

### Concurrency and memory

- The tool-argument cache is scoped per session/agent: two windows reusing a `callId` cannot
  cross-feed each other's arguments (covered by a test).
- Caches have hard limits: 256 entries / 2 MiB total / 256 KiB per entry for arguments, 64 entries /
  512 KiB for question rewrites, plus 5- and 10-minute TTLs.
- Logging is asynchronous: one bounded queue (500 lines), a serial drain, 2 MiB rotation to `.1`.
  `appendFileSync` on the approval hot path is gone — the host never waits for a log write.

### Privacy

- The `rewrite output failed validation` line used to include 160 characters of model output (which
  contains question text). It now logs only lengths.

### Tests

- 34 → 46 cases. New coverage: wrapper recognition (six shapes), destructive payloads one and two
  levels deep, encoded PowerShell, nested writes vs. harmless nesting, infinite nesting (bounded and
  fast), 40 wrappers on one line, 20 KB command truncation, nested approval-card copy, cross-session
  isolation, cache bounds, async logging (queue bound, dropped-line trace, unwritable target).
- All 46 pass on Node 24 via `node test/index.test.mjs`.

## 1.0.3

- Path lists only describe commands that actually change files: a `Set-Location C:\ws` prepended to a
  command no longer shows up as a file the operation will write or delete.
- Quoted expressions are no longer reported as paths: `"exists=$(Test-Path .\x.txt)"` used to appear as a
  phantom "file to be deleted" on the card; candidates containing `$(`, `=`, backticks or braces are rejected.
- Redirect targets and comma-separated arguments (`Remove-Item C:/a, C:/b`) are still extracted.
- Test suite: 32 → 34 cases. Verified end to end on DSH `0.2.1-rc.3`: write and destroy cards, and question
  rewriting, all reached the live session log.

## 1.0.2

- Neutral copy: removed the hardcoded "fat fish" persona (本鱼 / "this fish") from all cards;
  every template now lives in `locale/zh.json` and `locale/en.json` (identical key sets, enforced by tests),
  missing keys fall back to English, and the build marker follows `package.json`.
- Fixed English grammar in the mode clauses (`It widen this one …` → `The agent wants to widen this one …`).
- Split the single "high risk" class into **write** (`⚠️ 会写入文件`, e.g. `write`/`edit`, `Set-Content`,
  `Out-File`, `> file` redirects) and **destroy** (`🔴 高危操作`, e.g. `Remove-Item`/`rm`/`del`/`rd`,
  `git clean`, `git reset --hard`, `git checkout --`, `shutil.rmtree`, `os.remove`), so plain file writes
  are no longer reported as destructive and the previously missed destructive commands are now flagged.
- Short command aliases are only matched as the first word of each command segment, so paths like
  `C:\rd\notes.txt` are no longer mistaken for the `rd` command; `2>&1` is no longer treated as a redirect.
- Path fallback: when tool arguments are unavailable, paths are extracted from the approval note itself;
  redirect targets (`> log.txt`) are extracted; commands that name no path say so explicitly.
- Question rewrites are cached by card content (LRU, 64 entries): identical cards never pay tokens twice.
- Test suite expanded from 21 to 32 cases covering the classification table, grammar, locale parity,
  path fallbacks, and the rewrite cache.

## 1.0.1

- Corrected the GitHub owner in install instructions (`MMMichelsa`).
- Added `repository` / `homepage` / `bugs` metadata.
- Documented the tarball install fallback for machines without `git`.
- Repository layout must keep the entry at `lib/index.js` and tests at `test/index.test.mjs`.

## 1.0.0

Initial public release.

- Plain-language approval cards with risk classes:
  - `🟢` read-only note for read-type tools;
  - `⚠️ 高危操作，请确认` plus concrete file paths for write/edit/delete tools and hazardous shell commands;
  - neutral `⚙️` note otherwise.
- File paths come from `file_path` for `write` / `edit`, and from a labeled heuristic for shell commands.
- Question cards are rewritten through the current model provider; option labels are preserved byte-for-byte,
  non-Chinese labels gain a plain-language explanation in their descriptions.
- Only non-Chinese questions are sent to the model; Chinese-only batches cost nothing.
- Fail-open everywhere: rewriting failures fall back to the original text.
- Diagnostics log at `~/.dsh/dsh-plain-approvals.log` (no command/justification/question text).
