# dsh-plain-approvals

中文 | [English](README.md)

一个 DeepSeek Harness（DSH）profile 插件：把界面里最容易让人看不懂的两处改成大白话——

- **审批卡片**：按风险分级，并列出这次操作会碰到的具体文件；
- **模型提问**：用当前模型改写成通俗中文，同时保住回答用的 label 完全不变。

一切都是 fail-open：改写失败就原样显示，绝不卡住操作或改变结果。

> **状态：已在 DSH `0.2.1-rc.3` 实测通过。** 插件挂的是**内部 seam**（Cordis waterfall 和浏览器面板的 `displayReason` 字段），不是公开 API。DSH 升级后可能失效；失效时插件退化为显示原话，不会崩溃。

## 安装方式

在终端运行以下命令即可安装本插件：

```bash
dsh plugin --profile web add github:MMMichelsa/dsh-plain-approvals
```

安装后请重启 Harness 服务。

固定版本安装（推荐，标签发布后可用）：

```bash
dsh plugin --profile web add github:MMMichelsa/dsh-plain-approvals#v1.0.2
```

> 把 `web` 换成你实际的 profile 名（桌面版通常是 `desktop`）。安装需要网络，pnpm 会从 GitHub 拉取仓库。
>
> 如果本机没有 `git`（pnpm 报 git 相关错误），改用 tarball 安装：
>
> ```powershell
> dsh plugin --profile web add https://codeload.github.com/MMMichelsa/dsh-plain-approvals/tar.gz/refs/heads/main
> ```

确认 profile 的 `dsh.profile.bundles` 里含 `dsh-plain-approvals`。
卸载：`dsh plugin --profile web remove dsh-plain-approvals`，再从 `dsh.profile.bundles` 移除。

本地开发（link 本地目录）：

```powershell
dsh plugin --profile <profile> add link:<本仓库的绝对路径>
```

## 效果示意

```text
原始：允许本次操作使用 danger-full-access 权限：写 profile 配置

改后：⚠️ 会写入文件，请确认。助手要把「write」这一次调用放宽到 danger-full-access 权限
     （沙箱几乎完全关闭：可以读写这台电脑上的任意文件、运行任意系统命令、访问网络），
     并会写入：C:\Users\你\.dsh\profiles\desktop\cordis.patch.yml。
     授权只对这一次有效，批准后无法撤回；拿不准就拒绝，助手会停下来解释，不会绕开。
     理由：写 profile 配置。
```

删除 / 覆盖类操作会换成更醒目的 🔴 高危提示，并列出会被删除或覆盖的路径。

```text
原始提问：Which sandbox mode should the retry use?（选项 label 为 workspace-write / danger-full-access）

改后提问：这次重试应该用哪种权限？（选项 label 保持原样，描述里补中文解释）
```

## 它改什么

| 界面 | 原始样子 | 改后 |
|---|---|---|
| 读取类审批（罕见） | `允许本次操作使用 read-only 权限：…` | `🟢 读取操作：这次只是读取 <路径>，不会改动任何文件。…` |
| 写入类审批 | `允许本次操作使用 danger-full-access 权限：…` | `⚠️ 会写入文件，请确认。…并会写入：<路径清单>。…` |
| 删除 / 覆盖类审批 | 同上 | `🔴 高危操作，请确认！…它会删除或覆盖：<路径清单>。…` |
| 命令类审批（未发现删除/覆盖） | 技术化说明 | `⚙️ 需要你批准：…没有发现明显的删除或覆盖指令，但命令仍可能有副作用…` |
| 其它审批 | 工具自带说明 | `【需要你批准】…` |
| 模型提问卡片 | 模型原话（可能是英文或术语） | 改写成通俗中文；**选项 label 原样保留**，描述里补 label 的中文解释 |

## 风险分级

| 分类 | 依据 | 展示 |
|---|---|---|
| 读取 | 工具名属于 `read` / `read_image` / `glob` / `grep` / `web_fetch` 等 | `🟢` 只读提示，永不出现高危警告 |
| 写入 | `write` / `edit` / `apply_patch` / `str_replace_editor`；或命令首词是 `Set-Content` / `Add-Content` / `Out-File` / `Copy-Item` / `Move-Item` / `New-Item` / `tee` 等，或含 `> file` 输出重定向 | `⚠️ 会写入文件` + 路径清单 |
| 删除 | `delete_file` / `remove_file` 等；或命令首词是 `rm` / `del` / `rd` / `ri` / `rmdir` / `Remove-Item` / `Clear-Content` 等；或 `git clean` / `git reset --hard` / `git checkout --`；或脚本内 `shutil.rmtree` / `os.remove` | `🔴 高危操作` + 路径清单 |
| 其它 | 未匹配上述模式的命令；未知工具 | `⚙️` 中性提示 |

DSH 的审批请求按设计**不携带工具参数**，所以插件在 `tools/pre-execute` 上按 `callId` 缓存每次调用的
`arguments`（`tools/result` 时清掉，最多 256 条）。`write` / `edit` 的路径取自 `file_path`，精确；
`pwsh` / `bash` 只能从命令文本里启发式提取，卡片上会明确标注。两者都拿不到时，插件会再从审批说明里找一次路径，
仍找不到就明说「没能确定具体路径」。

## 它不改什么

- 不改审批的审计原因（`reason`）、不改批准结果、不代替你做决定；
- 不改提问的 `id`、`label`、`multi_select`、`intent` 和 `detail`（计划正文）；
- 不改任何工具参数或对话记录。改写只发生在「展示」这一层。

## 机制

- `approval/request`、`user-questions/request` 都是 Cordis waterfall，Host 会把它们转发给浏览器面板。
  插件用 `ctx.on(event, listener, { prepend: true, global: true })` 抢在转发之前拿到同一个请求对象：
  - 审批：替换 `displayReason`（`{ en, zh }`，只影响展示）；
  - 提问：调当前模型的 provider 改写 `question / header / option.description`。
- 工具参数在 `dsh-tools` 里被 `deepFreeze`，问题对象只读；插件先克隆、改克隆，再替换
  `request.questions`（`ask()` 新建的请求对象可写）。审批请求对象本身可写，直接改 `displayReason` 即可。
- 只有含非中文文字的问题才交给模型；纯中文问题整条跳过，零成本。

## 成本

- 审批卡片：纯本地模板，**零 token、零延迟**。
- 提问卡片：每批一次小模型调用（约 1–3 秒、几百 token），超时 15 秒；纯中文问题不调用；
  相同内容的卡片命中内存缓存，不再调用模型。
- 一切 fail-open：取不到模型、超时、输出不合规、label 对不上 → 显示原话。

## 诊断日志

插件每次事件向 `~/.dsh/dsh-plain-approvals.log` 追加一行：激活（带 build 标记）、审批分级
（kind / 沙箱模式 / 路径条数）、提问改写结果与失败原因。不记录命令正文、审批理由或问题正文。
可以随时删除该文件，插件会重建。

## 隐私与安全

- 插件从不替你批准或拒绝任何操作，只改展示文字；
- 提问文字会发给**当前**模型 provider 做改写（就是产出它的那个 provider），除此之外不外发；
- 插件自身不发网络请求、不读取凭据。

## 文案与语言包

所有展示文案都在 [`locale/zh.json`](locale/zh.json) 和 [`locale/en.json`](locale/en.json)，代码只负责填占位符；
某个 key 缺失时回落到英文，两条都没有就少说一句，不会显示 `{placeholder}`。想换语气直接改 JSON，不调模型、不改代码。
中英 key 必须一一对应，有测试守着。文案默认中性（「助手」/「the agent」），不带作者的个人口吻。

## 开发

```bash
npm test            # 运行 node test/index.test.mjs
```

DSH 沙箱内 `node --test` 无法拉起子进程，所以测试是一个直接用 `node:test` 的普通脚本。
发布流程见 [RELEASING.md](RELEASING.md)。

## 兼容性

- Node.js >= 20。
- 已在 DSH `0.2.1-rc.3`（desktop profile，Web UI）实测通过。
- 依赖内部 seam：`approval/request`、`user-questions/request`、`tools/pre-execute`、`tools/result`，
  以及客户端审批面板的 `displayReason`。不是公开 API。

## 已知限制

- 纯文本卡片：颜色和字号由内置审批面板的 CSS 决定，真正的红底大字需要另做客户端 UI 插件；
- 命令识别是启发式的：短别名只看每条命令的第一个词（`Get-ChildItem C:\rd\x` 不会被误判成 `rd`），
  长写法（`Remove-Item`、`shutil.rmtree`）出现在命令任意位置都算；被编码或藏在嵌套脚本里的删除仍可能漏判；
- 命令里的路径是启发式的，卡片上会标注「从命令里提取，可能不全」；
- 提问改写结果按卡片内容做内存缓存（最多 64 条），相同卡片不会重复花 token；
- `read` 类操作通常不触发审批，所以绿色提示很少出现。

## 许可证

MIT，见 [LICENSE](LICENSE)。
