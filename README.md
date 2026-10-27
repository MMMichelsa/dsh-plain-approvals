# dsh-plain-approvals

[中文](README.zh.md) | English

A DeepSeek Harness (DSH) profile plugin that rewrites the two most technical moments of the UI into plain language:

- **Approval cards** — risk-classified, with the exact files an operation will touch;
- **Model questions** — rewritten into plain language by the current model, with stable answer vocabulary preserved.

Everything is fail-open: if rewriting fails for any reason, the original text is shown and the operation is never blocked or altered.

> **Status: tested against DSH `0.2.1-rc.3`.** This plugin hooks *internal* seams (Cordis waterfalls and the browser panel's `displayReason` field). Those are not public API and may change in future DSH releases. When they do, the plugin degrades to showing the original text.

## Install

Install from GitHub:

```bash
dsh plugin --profile web add github:MMMichelsa/dsh-plain-approvals
```

Restart the Harness service afterwards.

Pinned version (recommended once the tag exists):

```bash
dsh plugin --profile web add github:MMMichelsa/dsh-plain-approvals#v1.0.2
```

> Replace `web` with your own profile name (desktop builds usually use `desktop`). Installation needs network access: pnpm fetches the repository from GitHub.
>
> If `git` is not installed (pnpm reports a git error), install from the tarball instead:
>
> ```powershell
> dsh plugin --profile web add https://codeload.github.com/MMMichelsa/dsh-plain-approvals/tar.gz/refs/heads/main
> ```

Confirm `dsh-plain-approvals` ends up in the profile's `dsh.profile.bundles`.
Uninstall with `dsh plugin --profile web remove dsh-plain-approvals` and remove it from `dsh.profile.bundles`.

Local development (link a checkout):

```powershell
dsh plugin --profile <profile> add link:<absolute path to this repo>
```

## What it looks like

```text
Before: Allow this operation with danger-full-access permissions: update the profile config

After:  ⚠️ 会写入文件，请确认。助手要把「write」这一次调用放宽到 danger-full-access 权限
        （沙箱几乎完全关闭：可以读写这台电脑上的任意文件、运行任意系统命令、访问网络），
        并会写入：C:\Users\you\.dsh\profiles\desktop\cordis.patch.yml。
        授权只对这一次有效，批准后无法撤回；拿不准就拒绝，助手会停下来解释，不会绕开。
        理由：update the profile config
```

Delete / overwrite operations get a louder 🔴 card with the exact paths they will remove or overwrite.
English cards carry the same information, e.g. `🔴 DESTRUCTIVE OPERATION — please confirm. The agent wants to widen this one "pwsh" call to danger-full-access (…), and it will delete or overwrite: …`.

```text
Before: Which sandbox mode should the retry use?  (option labels: workspace-write / danger-full-access)

After: 这次重试应该用哪种权限？ (option labels unchanged; descriptions gain the Chinese explanation)
```

## What it changes

| UI | Before | After |
|---|---|---|
| Read-type approval (rare) | `Allow this operation with read-only permissions: …` | `🟢 读取操作：这次只是读取 <path>，不会改动任何文件。…` |
| Write-type approval | `Allow this operation with danger-full-access permissions: …` | `⚠️ 会写入文件，请确认。…并会写入：<path list>。…` |
| Delete / overwrite approval | same | `🔴 高危操作，请确认！…它会删除或覆盖：<path list>。…` |
| Command approval without an obvious delete/overwrite | technical wording | `⚙️ 需要你批准：…没有发现明显的删除或覆盖指令，但命令仍可能有副作用…` |
| Other approvals | the asker's own wording | `【需要你批准】…` |
| Model question cards | model wording (possibly English or jargon) | rewritten into plain Chinese; **option labels stay byte-identical**, descriptions gain a label explanation |

## Risk classification

| Class | Basis | Presentation |
|---|---|---|
| Read | tool name is `read`, `read_image`, `glob`, `grep`, `web_fetch`, … | `🟢` read-only note, never a high-risk warning |
| Write | `write` / `edit` / `apply_patch` / `str_replace_editor`; or a command whose first word is `Set-Content`, `Add-Content`, `Out-File`, `Copy-Item`, `Move-Item`, `New-Item`, `tee`, …; or a `> file` output redirect | `⚠️ 会写入文件` plus the paths |
| Delete | `delete_file` / `remove_file`, …; or a command whose first word is `rm`, `del`, `rd`, `ri`, `rmdir`, `Remove-Item`, `Clear-Content`, …; or `git clean` / `git reset --hard` / `git checkout --`; or `shutil.rmtree` / `os.remove` inside a script | `🔴 高危操作` plus the paths |
| Other | shell commands without any of the above; unknown tools | neutral `⚙️` note |

Approval requests do not carry tool arguments (by design in DSH), so the plugin caches each call's `arguments` from `tools/pre-execute` (keyed by `callId`, cleared on `tools/result`, at most 256 entries). File paths for `write` / `edit` come from `file_path` exactly; for `pwsh` / `bash` they are extracted heuristically from the command and the card says so. When neither source yields a path, the plugin falls back to paths found in the approval note, and otherwise says the path is unknown instead of guessing.

## What it does not change

- The audit `reason`, the approval outcome, or your decision;
- Question `id`, `label`, `multi_select`, `intent`, `detail` (plan body);
- Tool arguments or conversation records. Rewriting happens in the presentation layer only.

## How it works

- `approval/request` and `user-questions/request` are Cordis waterfalls that the host forwards to the browser panel. The plugin registers with `ctx.on(event, listener, { prepend: true, global: true })`, gets the same request object first, and:
  - approvals: replaces `displayReason` (`{ en, zh }`, presentation only);
  - questions: calls the current model provider to rewrite `question / header / option.description`.
- Tool arguments are `deepFreeze`d by `dsh-tools`, so question objects are read-only. The plugin clones them, rewrites the clones, and replaces `request.questions`; approval request objects are writable, so `displayReason` is replaced in place.
- Question rewriting only runs when some displayed text is not Chinese; fully Chinese questions are skipped at zero cost.

## Cost

- Approvals: local templates, **zero tokens, zero latency**.
- Questions: one small model call per batch (about 1–3 s, a few hundred tokens), 15 s timeout; skipped entirely for Chinese-only questions. Results are cached in memory (up to 64 cards), so identical questions never cost twice.
- Fail-open everywhere: missing model, timeout, invalid output, label mismatch → original text.

## Copy and localization

All user-visible copy lives in [`locale/zh.json`](locale/zh.json) and [`locale/en.json`](locale/en.json); the code only fills placeholders. A missing key falls back to English, and a key missing from both locales drops the sentence rather than printing `{placeholder}`. Change the wording by editing those JSON files — no model call, no code change. The two locale files must have identical keys, which the test suite enforces. Copy is neutral (“the agent” / 「助手」) and carries no author-specific persona.

## Diagnostics

The plugin appends one line per event to `~/.dsh/dsh-plain-approvals.log`: activation (with build marker), approval classification (`kind`, sandbox mode, number of paths), question rewrite outcome and failure reason. It never logs command text, approval justifications, or question text. Delete the file at any time; it is recreated.

## Privacy and security

- The plugin never approves or denies anything on its own; it only changes display text.
- Question text is sent to the *current* model provider for rewriting — the same provider that produced it. Nothing is sent anywhere else.
- No network calls of its own; no credentials are read.

## Development

```bash
npm test            # runs node test/index.test.mjs
```

`node --test` cannot spawn child processes inside DSH's sandbox, so the suite is a plain script using `node:test` directly.
Release steps are in [RELEASING.md](RELEASING.md).

## Compatibility

- Node.js >= 20.
- Tested on DSH `0.2.1-rc.3` (desktop profile, web UI).
- Relies on internal seams: `approval/request`, `user-questions/request`, `tools/pre-execute`, `tools/result`, and the client approval panel's `displayReason`. Not official API.

## Known limitations

- Text-only cards: colors and font sizes are owned by the built-in approval panel; a true red banner needs a separate client-UI plugin.
- Command risk detection is heuristic: short aliases are only matched as the first word of each command segment (so `Get-ChildItem C:\rd\x` is not mistaken for `rd`), while long forms (`Remove-Item`, `shutil.rmtree`) match anywhere in the command. Deletes hidden in encoded or nested scripts can still be missed.
- Shell path extraction is heuristic; it is labeled as such on the card.
- `read` tools do not normally trigger approvals, so the green note is rarely seen in practice.

## License

MIT — see [LICENSE](LICENSE).
