# Changelog

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
