# Changelog

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
