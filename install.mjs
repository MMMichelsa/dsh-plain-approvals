#!/usr/bin/env node
/**
 * dsh-plain-approvals 一键安装器（跨平台）
 *
 * 设计目标（都是实测踩过的坑）：
 *  - 小白双击就能装：不需要先配环境变量，自己去找 Node 与 DSH 的 CLI；
 *  - 中文提示不乱码：Windows 上先把控制台切到 UTF-8，再输出；
 *  - 路径里有空格 / 中文也不炸：所有参数用数组传递或严格引用，不拼模糊的字符串；
 *  - 装到正确的 profile：默认 `desktop`（桌面客户端加载的就是它），装错 profile 是
 *    「装上了但没反应」的头号原因；
 *  - 失败要能自己退：github: 源需要 git，没有 git 就自动退到 tarball，再退到本地目录；
 *  - 不留烂摊子：动手前备份 profile 的 package.json 与 pnpm-lock.yaml。
 *
 * 用法：
 *   node install.mjs                     # 装进 desktop
 *   node install.mjs --profile 名字       # 换 profile
 *   node install.mjs --local             # 从当前目录安装（link:，开发用）
 *   node install.mjs --from <spec>       # 指定安装源（github: / tarball / link:）
 *   node install.mjs --dsh <path>        # 手动指定 dsh CLI
 *   node install.mjs --dry-run           # 只打印计划，不动手
 */

import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = 'dsh-plain-approvals'
const REPO = 'MMMichelsa/dsh-plain-approvals'
const DEFAULT_PROFILE = 'desktop'

/* ── 输出：颜色可有可无，编码必须对 ─────────────────────────────────────── */

const COLOR = process.stdout.isTTY === true && !process.env.NO_COLOR
const paint = (code) => (text) => (COLOR ? `\u001b[${code}m${text}\u001b[0m` : text)
const bold = paint('1')
const dim = paint('2')
const green = paint('32')
const yellow = paint('33')
const red = paint('31')
const cyan = paint('36')

/**
 * Windows 控制台默认是 936(GBK) 之类的代码页，直接输出 UTF-8 会花屏。
 * `chcp.com` 改的是整个控制台的代码页（进程共享），所以从子进程调用同样有效。
 */
function ensureUtf8Console() {
  if (process.platform !== 'win32') return
  const com = process.env.ComSpec || 'cmd.exe'
  try {
    spawnSync(com, ['/d', '/c', 'chcp 65001'], { stdio: 'ignore', windowsHide: true })
  } catch {
    // 改不了就算了，下面的 ASCII 兜底提示仍然能看懂
  }
}

const line = (text = '') => process.stdout.write(`${text}\n`)
const step = (index, text) => line(`${cyan(`[${index}]`)} ${text}`)
const ok = (text) => line(`    ${green('✓')} ${text}`)
const warn = (text) => line(`    ${yellow('!')} ${text}`)
const fail = (text) => line(`    ${red('✗')} ${text}`)
const hint = (text) => line(`      ${dim(text)}`)

/* ── 参数 ─────────────────────────────────────────────────────────────── */

function parseArgs(argv) {
  const options = {
    profile: DEFAULT_PROFILE,
    from: '',
    dsh: '',
    local: false,
    dryRun: false,
    help: false,
  }
  const takeValue = (index, flag) => {
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${flag} 后面要跟一个值`)
    }
    return value
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--local') options.local = true
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--profile') options.profile = takeValue(index++, '--profile')
    else if (arg.startsWith('--profile=')) options.profile = arg.slice('--profile='.length)
    else if (arg === '--from') options.from = takeValue(index++, '--from')
    else if (arg.startsWith('--from=')) options.from = arg.slice('--from='.length)
    else if (arg === '--dsh') options.dsh = takeValue(index++, '--dsh')
    else if (arg.startsWith('--dsh=')) options.dsh = arg.slice('--dsh='.length)
    else throw new Error(`看不懂的参数：${arg}`)
  }
  return options
}

function printHelp() {
  line(bold('dsh-plain-approvals 安装器'))
  line('')
  line('  node install.mjs                       装进 desktop（默认）')
  line('  node install.mjs --profile <名字>       装进别的 profile')
  line('  node install.mjs --local               从当前目录安装（开发用）')
  line('  node install.mjs --from <安装源>        指定安装源')
  line('  node install.mjs --dsh <路径>           手动指定 dsh 命令行')
  line('  node install.mjs --dry-run             只看计划，不动手')
  line('')
  line(dim('  Windows 用户直接双击 install.bat 即可，不用看这些。'))
}

/* ── 找东西 ───────────────────────────────────────────────────────────── */

const isFile = (path) => {
  try {
    return existsSync(path)
  } catch {
    return false
  }
}

/** 在 PATH 里按名字找可执行文件（不依赖用户的 shell 配置）。 */
function findInPath(names) {
  const raw = process.env.PATH ?? ''
  const dirs = raw.split(process.platform === 'win32' ? ';' : ':').filter(Boolean)
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = join(dir, name)
      if (isFile(candidate)) return candidate
    }
  }
  return ''
}

/** DSH 桌面版把 CLI 放在安装目录的 resources/runtime/cli/bin 下。 */
function findDesktopCli() {
  if (process.platform === 'win32') {
    const roots = [
      process.env.LOCALAPPDATA,
      process.env.ProgramFiles,
      process.env['ProgramFiles(x86)'],
    ].filter(Boolean)
    for (const root of roots) {
      for (const app of ['DeepSeek Harness', 'DeepSeekHarness']) {
        const candidate = join(root, 'Programs', app, 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd')
        if (isFile(candidate)) return candidate
        const plain = join(root, app, 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd')
        if (isFile(plain)) return plain
      }
    }
    return ''
  }
  const candidates = process.platform === 'darwin'
    ? ['/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh']
    : [
      join(homedir(), '.local', 'share', 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh'),
      '/opt/DeepSeek Harness/resources/runtime/cli/bin/dsh',
    ]
  for (const candidate of candidates) if (isFile(candidate)) return candidate
  return ''
}

/** 依次尝试：显式指定 → 环境变量 → PATH → 桌面版安装目录。 */
function resolveDsh(explicit) {
  const tried = []
  const consider = (path, label) => {
    if (!path) return ''
    tried.push(`${label}: ${path}`)
    return isFile(path) ? path : ''
  }
  const fromFlag = consider(explicit, '参数 --dsh')
  if (fromFlag) return { path: fromFlag, tried }
  const fromEnv = consider(process.env.DSH_CLI, '环境变量 DSH_CLI')
  if (fromEnv) return { path: fromEnv, tried }
  const names = process.platform === 'win32' ? ['dsh.cmd', 'dsh.exe', 'dsh.bat'] : ['dsh']
  const fromPath = consider(findInPath(names), 'PATH')
  if (fromPath) return { path: fromPath, tried }
  const fromDesktop = consider(findDesktopCli(), '桌面版安装目录')
  if (fromDesktop) return { path: fromDesktop, tried }
  return { path: '', tried }
}

const dshHome = () => process.env.DSH_HOME || join(homedir(), '.dsh')

function availableProfiles() {
  const dir = join(dshHome(), 'profiles')
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch {
    return []
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

function installedState(profile) {
  const dir = join(dshHome(), 'profiles', profile)
  const manifest = readJson(join(dir, 'package.json'))
  const installedManifest = readJson(join(dir, 'node_modules', PLUGIN, 'package.json'))
  return {
    dir,
    hasProfile: isFile(join(dir, 'package.json')),
    dependency: manifest?.dependencies?.[PLUGIN] ?? null,
    inBundles: Array.isArray(manifest?.dsh?.profile?.bundles) && manifest.dsh.profile.bundles.includes(PLUGIN),
    version: installedManifest?.version ?? null,
    hasFiles: isFile(join(dir, 'node_modules', PLUGIN, 'package.json')),
  }
}

/* ── 执行 ─────────────────────────────────────────────────────────────── */

const quoteWin = (value) => (/[\s"&|<>^]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value)

/**
 * 跑一条 dsh 命令，输出直接透传给用户（小白要看得见进度）。
 *
 * 刻意用 `stdio: 'inherit'` 而不是管道：受限环境（例如 DSH 自己的沙箱）不允许
 * 子进程通过管道通信，接管输出会让安装直接 EPERM。能不能拿到返回值无所谓，
 * 装没装成功由下面的「校验」说了算。
 *
 * Windows 上 `dsh` 是 .cmd，必须经 cmd.exe 启动，且路径要引用——空格路径就靠这里。
 */
function runDsh(dsh, args) {
  const options = { stdio: 'inherit', windowsHide: false }
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(dsh)) {
    const cmdline = [quoteWin(dsh), ...args.map(quoteWin)].join(' ')
    // windowsVerbatimArguments：若交给 Node 自己拼命令行，它会把我们加好的引号
    // 再转义一遍（`"` → `\"`），cmd 就找不到程序了（实测报「网络路径不存在」）。
    return spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${cmdline}"`], {
      ...options,
      windowsVerbatimArguments: true,
    })
  }
  return spawnSync(dsh, args, options)
}

function backupProfile(profile) {
  const dir = join(dshHome(), 'profiles', profile)
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-')
  const saved = []
  for (const name of ['package.json', 'pnpm-lock.yaml']) {
    const source = join(dir, name)
    if (!isFile(source)) continue
    const target = `${source}.bak-${stamp}`
    try {
      copyFileSync(source, target)
      saved.push(target)
    } catch {
      warn(`备份失败（继续安装）：${name}`)
    }
  }
  return saved
}

function ownVersion() {
  const manifest = readJson(join(HERE, 'package.json'))
  return typeof manifest?.version === 'string' ? manifest.version : ''
}

/** 安装源候选：每一条都是「能装就装，装不上退下一条」。 */
function installSpecs(options, version) {
  if (options.from) return [{ spec: options.from, label: '你指定的安装源' }]
  if (options.local) return [{ spec: `link:${resolve(HERE)}`, label: '当前目录（link，开发用）' }]
  const tag = version ? `v${version}` : 'main'
  return [
    { spec: `github:${REPO}#${tag}`, label: `GitHub 固定版本 ${tag}` },
    { spec: `https://codeload.github.com/${REPO}/tar.gz/refs/tags/${tag}`, label: `GitHub 压缩包 ${tag}（不需要 git）` },
    { spec: `https://codeload.github.com/${REPO}/tar.gz/refs/heads/main`, label: 'GitHub 压缩包 main 分支（不需要 git）' },
    { spec: `link:${resolve(HERE)}`, label: '当前目录（link，最后兜底）' },
  ]
}

/* ── 主流程 ──────────────────────────────────────────────────────────── */

function main() {
  ensureUtf8Console()

  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    fail(error.message)
    line('')
    printHelp()
    return 2
  }
  if (options.help) {
    printHelp()
    return 0
  }

  line('')
  line(bold('  dsh-plain-approvals 安装器'))
  line(dim('  把「需要你许可」的界面改成大白话'))
  line('')

  const version = ownVersion()

  step(1, '检查 Node.js')
  ok(`当前 Node.js 版本 ${process.version}`)

  step(2, `检查 profile「${bold(options.profile)}」`)
  const profiles = availableProfiles()
  const before = installedState(options.profile)
  if (!before.hasProfile) {
    fail(`没有找到 profile：${join(dshHome(), 'profiles', options.profile)}`)
    if (profiles.length > 0) {
      hint(`本机现有的 profile：${profiles.join('、')}`)
      hint(`如果桌面版就用 desktop，可以试着运行：node install.mjs --profile desktop`)
    } else {
      hint('这台电脑上似乎还没有任何 profile——先启动一次 DeepSeek Harness 桌面版再来。')
    }
    return 1
  }
  if (before.hasFiles && before.inBundles) {
    warn(`已经装过 ${before.version ? `v${before.version}` : '一份'}，这次是升级/重装`)
  }
  ok(`profile 目录：${before.dir}`)

  step(3, '查找 dsh 命令行工具')
  const found = resolveDsh(options.dsh)
  if (!found.path) {
    fail('没有找到 dsh 命令行工具')
    hint('可以先用 Windows 的「DeepSeek Harness」桌面版跑一次，安装器会自动找到它；')
    hint('或者手动指定：node install.mjs --dsh "C:\\...\\dsh.cmd"')
    for (const entry of found.tried) hint(entry)
    return 1
  }
  ok(`找到：${found.path}`)

  const specs = installSpecs(options, version)
  if (options.dryRun) {
    step(4, '只打印计划（--dry-run）')
    for (const item of specs) line(`    · ${item.label}  →  ${item.spec}`)
    line('')
    line(dim('  未做任何修改。去掉 --dry-run 即开始安装。'))
    return 0
  }

  step(4, '备份当前 profile 配置')
  const backups = backupProfile(options.profile)
  if (backups.length === 0) warn('没有可备份的文件（新 profile？），继续。')
  for (const path of backups) ok(`已备份：${path.split(/[\\/]/).pop()}`)

  step(5, '开始安装')
  let installed = false
  for (const item of specs) {
    line(`    ${cyan('→')} 尝试：${item.label}`)
    const result = runDsh(found.path, ['plugin', '--profile', options.profile, 'add', item.spec])
    const after = installedState(options.profile)
    const complete = after.hasFiles && after.inBundles
    // 依赖写进去了但没进 bundles：DSH 会加载不到。这种情况不重试，直接指出问题。
    if (after.hasFiles && !after.inBundles) {
      warn('插件文件已就位，但没有写进 dsh.profile.bundles，需要手动补一行。')
      hint(`在 ${join(after.dir, 'package.json')} 的 dsh.profile.bundles 里加上 "${PLUGIN}"`)
      installed = after.hasFiles
      break
    }
    if (result.status === 0 && complete) {
      ok(`安装成功（${item.label}）`)
      installed = true
      break
    }
    if (result.status === 0 && !complete) {
      fail('命令报告成功，但校验没通过，换下一种方式再试')
    } else {
      warn(`这一步失败（退出码 ${result.status ?? '?'}），换下一种方式`)
    }
    line('')
  }

  if (!installed) {
    line('')
    fail('三种方式都没装成。')
    hint('逐条对照试试：')
    hint('1) 确认网络能打开 github.com；公司网络常拦 codeload。')
    hint(`2) 手动执行：${found.path} plugin --profile ${options.profile} add github:${REPO}`)
    hint('3) 把完整报错发给我，我照着修。')
    return 1
  }

  const final = installedState(options.profile)
  line('')
  line(green(bold('  装好了。')))
  line(`    插件版本：${final.dependency && final.dependency.includes('#') ? final.dependency.split('#').pop() : (final.version ?? '未知')}`)
  line(`    安装位置：${join(final.dir, 'node_modules', PLUGIN)}`)
  line('')
  line(bold('  最后一步：重启 DeepSeek Harness 桌面版'))
  hint('完全退出应用（托盘图标也要退出）再重新打开，插件才会加载。')
  hint('重启后随便触发一次需要批准的操作，能看到 🟢 / ⚠️ / 🔴 字样就说明生效了。')
  line('')
  return 0
}

let code = 1
try {
  code = main()
} catch (error) {
  line('')
  fail(`安装器自己出错了：${error instanceof Error ? error.message : String(error)}`)
  hint('这不影响你已有的配置；把上面这段报错发给我即可。')
  code = 1
}
process.exitCode = code
