import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  apply,
  applyQuestionRewrites,
  approvalDisplayText,
  buildRewritePrompt,
  classifyCommand,
  classifyOperation,
  collectArgsPaths,
  decorateApprovalRequest,
  forgetToolCall,
  needsRewrite,
  parseRewrittenArray,
  parseSandboxReason,
  pathsFromCommand,
  pathsFromText,
  rememberToolCall,
  rewriteQuestions,
} from '../lib/index.js'

const readLocale = (id) => JSON.parse(readFileSync(new URL(`../locale/${id}.json`, import.meta.url), 'utf8'))
const ZH = readLocale('zh')
const EN = readLocale('en')

const sandboxRequest = (callId, mode = 'danger-full-access', justify = '需要读取工作区外的驱动版本信息') => ({
  toolName: 'pwsh',
  ...(callId === undefined ? {} : { callId }),
  reason: `escalate sandbox to ${mode}: ${justify}`,
})

test('parseSandboxReason: 解析模式与理由', () => {
  const parsed = parseSandboxReason('escalate sandbox to workspace-write: 需要写入 C:/temp')
  assert.deepEqual(parsed, { mode: 'workspace-write', justification: '需要写入 C:/temp' })
  assert.equal(parseSandboxReason('escalate sandbox to danger-full-access:'), null)
  assert.equal(parseSandboxReason('the user asked'), null)
  assert.equal(parseSandboxReason(undefined), null)
})

test('classifyOperation: 读取 / 写入 / 删除 / 其它', () => {
  const read = classifyOperation('read', { file_path: 'C:/a.txt' })
  assert.equal(read.kind, 'read')
  assert.deepEqual(read.paths, ['C:/a.txt'])
  assert.equal(read.pathSource, 'args')

  const write = classifyOperation('write', { file_path: 'C:/a.txt', content: 'x' })
  assert.equal(write.kind, 'write')
  assert.deepEqual(write.paths, ['C:/a.txt'])

  assert.equal(classifyOperation('edit', { file_path: 'C:/a.txt' }).kind, 'write')
  assert.equal(classifyOperation('delete_file', { file_path: 'C:/a.txt' }).kind, 'destroy')
  assert.equal(classifyOperation('some-tool', { anything: 1 }).kind, 'neutral')
})

test('classifyCommand: 删除类命令（含原先漏报的写法）', () => {
  for (const command of [
    'Remove-Item C:/tmp/x.txt -Force',
    'rm -rf ./build',
    'del /q C:/tmp/a.txt',
    'ri -Recurse C:/tmp/dir',
    'rd /s /q C:/tmp/dir',
    'git clean -fdx',
    'git reset --hard HEAD~1',
    'git checkout -- src/app.ts',
    'python -c "import shutil; shutil.rmtree(\'build\')"',
    'python -c "import os; os.remove(\'a.txt\')"',
  ]) {
    const verdict = classifyCommand(command)
    assert.equal(verdict, 'destroy', `expected destroy: ${command}`)
  }
})

test('classifyCommand: 写入类命令（原先被误判为高危）', () => {
  for (const command of [
    'Get-Date > log.txt',
    'Set-Content -Path C:/a.txt -Value x',
    "Add-Content C:/a.txt 'x'",
    'Out-File -FilePath C:/a.txt',
    'Copy-Item C:/a.txt C:/b.txt',
    'New-Item -ItemType Directory C:/tmp/new',
    'Get-ChildItem | Tee-Object C:/a.txt',
  ]) {
    assert.equal(classifyCommand(command), 'write', `expected write: ${command}`)
  }
})

test('classifyCommand: 不误报路径里的短别名与句柄重定向', () => {
  assert.equal(classifyCommand('Get-ChildItem C:\\rd\\notes.txt'), 'neutral')
  assert.equal(classifyCommand('Get-Date 2>&1'), 'neutral')
  assert.equal(classifyCommand('git status'), 'neutral')
  assert.equal(classifyCommand('npm test'), 'neutral')
  assert.equal(classifyCommand(''), 'neutral')
})

test('collectArgsPaths / pathsFromCommand / pathsFromText: 提取路径', () => {
  assert.deepEqual(collectArgsPaths({ file_path: 'C:/a.txt', other: 'nope' }), ['C:/a.txt'])
  assert.deepEqual(collectArgsPaths({ files: ['C:/a.txt', 'C:/b.txt'] }), ['C:/a.txt', 'C:/b.txt'])
  assert.deepEqual(collectArgsPaths(null), [])

  const paths = pathsFromCommand('Move-Item "C:/a.txt" C:/b.txt; Remove-Item C:/c/d.txt')
  assert.ok(paths.includes('C:/a.txt'))
  assert.ok(paths.includes('C:/c/d.txt'))

  const fromText = pathsFromText('要改写 C:/Users/me/.dsh/cordis.yml 和 /home/me/.config/app.yml')
  assert.ok(fromText.includes('C:/Users/me/.dsh/cordis.yml'))
  assert.ok(fromText.includes('/home/me/.config/app.yml'))
  assert.deepEqual(pathsFromText('没有路径'), [])
})

test('approvalDisplayText: 沙箱提权但看不出命令 → 中性提示，带模式解释与理由', () => {
  const text = approvalDisplayText(sandboxRequest())
  assert.match(text.zh, /⚙️/)
  assert.match(text.zh, /danger-full-access/)
  assert.match(text.zh, /沙箱几乎完全关闭/)
  assert.match(text.zh, /只对这一次有效/)
  assert.match(text.zh, /需要读取工作区外的驱动版本信息/)
  assert.match(text.en, /Approval needed/)
  assert.match(text.en, /single request/)
})

test('approvalDisplayText: 写文件 → 写入警告 + 具体路径', () => {
  rememberToolCall({ callId: 'call-write', arguments: { file_path: 'C:/tmp/secret.txt', content: 'x' } })
  try {
    const text = approvalDisplayText({
      toolName: 'write',
      callId: 'call-write',
      reason: 'escalate sandbox to danger-full-access: 覆写工作区外的配置文件',
    })
    assert.match(text.zh, /⚠️ 会写入文件/)
    assert.match(text.zh, /C:\/tmp\/secret\.txt/)
    assert.match(text.zh, /覆写工作区外的配置文件/)
    assert.match(text.en, /FILE WRITES AHEAD/)
    assert.match(text.en, /C:\/tmp\/secret\.txt/)
    assert.doesNotMatch(text.zh, /高危操作/)
  } finally {
    forgetToolCall({ callId: 'call-write' })
  }
})

test('approvalDisplayText: 删除命令 → 高危 + 命令里提取的路径', () => {
  rememberToolCall({ callId: 'call-rm', arguments: { command: 'Remove-Item C:/tmp/old.txt -Force' } })
  try {
    const text = approvalDisplayText({
      toolName: 'pwsh',
      callId: 'call-rm',
      reason: 'escalate sandbox to danger-full-access: 清理临时文件',
    })
    assert.match(text.zh, /🔴 高危操作/)
    assert.match(text.zh, /C:\/tmp\/old\.txt/)
    assert.match(text.zh, /从命令里提取/)
    assert.match(text.en, /DESTRUCTIVE OPERATION/)
  } finally {
    forgetToolCall({ callId: 'call-rm' })
  }
})

test('approvalDisplayText: git clean -fdx 也算高危（原先漏报）', () => {
  rememberToolCall({ callId: 'call-git', arguments: { command: 'git clean -fdx' } })
  try {
    const text = approvalDisplayText({
      toolName: 'pwsh',
      callId: 'call-git',
      reason: 'escalate sandbox to danger-full-access: 清理未跟踪文件',
    })
    assert.match(text.zh, /🔴 高危操作/)
    assert.match(text.zh, /命令里没有写明具体路径/)
  } finally {
    forgetToolCall({ callId: 'call-git' })
  }
})

test('approvalDisplayText: 重定向目标算写入路径', () => {
  rememberToolCall({ callId: 'call-redirect', arguments: { command: 'Get-Date > log.txt' } })
  try {
    const text = approvalDisplayText({
      toolName: 'pwsh',
      callId: 'call-redirect',
      reason: 'escalate sandbox to workspace-write: 记录时间',
    })
    assert.match(text.zh, /log\.txt/)
    assert.match(text.zh, /从命令里提取/)
  } finally {
    forgetToolCall({ callId: 'call-redirect' })
  }
})

test('approvalDisplayText: 只写命令 → 写入警告而不是高危（原先误报）', () => {
  rememberToolCall({ callId: 'call-log', arguments: { command: 'Get-Date > log.txt' } })
  try {
    const text = approvalDisplayText({
      toolName: 'pwsh',
      callId: 'call-log',
      reason: 'escalate sandbox to workspace-write: 记录时间',
    })
    assert.match(text.zh, /⚠️ 会写入文件/)
    assert.doesNotMatch(text.zh, /🔴/)
  } finally {
    forgetToolCall({ callId: 'call-log' })
  }
})

test('approvalDisplayText: 读取 → 绿色只读提示，不出现高危警告', () => {
  rememberToolCall({ callId: 'call-read', arguments: { file_path: 'C:/logs/app.log' } })
  try {
    const text = approvalDisplayText({
      toolName: 'read',
      callId: 'call-read',
      reason: 'escalate sandbox to read-only: 读取日志定位问题',
    })
    assert.match(text.zh, /🟢 读取操作/)
    assert.match(text.zh, /C:\/logs\/app\.log/)
    assert.doesNotMatch(text.zh, /高危|会写入/)
    assert.match(text.en, /Read-only operation/)
  } finally {
    forgetToolCall({ callId: 'call-read' })
  }
})

test('approvalDisplayText: 拿不到工具参数时，从审批说明里兜底找路径', () => {
  const text = approvalDisplayText({
    toolName: 'write',
    reason: 'escalate sandbox to danger-full-access: 覆写 C:/Users/me/.dsh/profiles/desktop/cordis.patch.yml',
  })
  assert.match(text.zh, /cordis\.patch\.yml/)
  assert.match(text.zh, /从审批说明里提取/)
})

test('approvalDisplayText: 既没有参数也没有路径时给出明确占位', () => {
  const text = approvalDisplayText({ toolName: 'write', reason: 'escalate sandbox to danger-full-access: 写入文件' })
  assert.match(text.zh, /没能从参数里确定具体路径/)
  assert.match(text.en, /no concrete path/)
})

test('approvalDisplayText: 非沙箱审批保留原始说明', () => {
  const text = approvalDisplayText({
    toolName: 'some-tool',
    reason: 'tool "some-tool" requires approval',
    displayReason: { en: 'Allow the tool to run', zh: '允许该工具运行' },
  })
  assert.match(text.zh, /需要你批准/)
  assert.match(text.zh, /允许该工具运行/)
  assert.match(text.en, /Allow the tool to run/)
})

test('文案：不再出现人设词，英文不再有 widen 语法错', () => {
  const samples = [
    approvalDisplayText(sandboxRequest()),
    approvalDisplayText({
      toolName: 'write',
      callId: 'x-none',
      reason: 'escalate sandbox to danger-full-access: 写入',
    }),
    approvalDisplayText({ toolName: 'some-tool', reason: 'needs approval' }),
  ]
  for (const text of samples) {
    for (const value of [text.zh, text.en]) {
      assert.doesNotMatch(value, /本鱼/)
      assert.doesNotMatch(value, /this fish/i)
      assert.doesNotMatch(value, /\bIt widen\b|\bThis widen\b|\bwiden this one ".*" call to .*\)?, and it will change/)
      assert.doesNotMatch(value, /\{[a-z_]+\}/, 'unfilled placeholder')
    }
  }
})

test('语言包：中英 key 一致，模式解释齐全', () => {
  assert.deepEqual(Object.keys(ZH).sort(), Object.keys(EN).sort())
  for (const mode of ['read-only', 'workspace-write', 'danger-full-access', 'fallback']) {
    assert.equal(typeof ZH[`mode.${mode}`], 'string')
    assert.equal(typeof EN[`mode.${mode}`], 'string')
  }
})

test('decorateApprovalRequest: 只改 displayReason，不动 reason', () => {
  const request = sandboxRequest()
  const before = request.reason
  assert.equal(decorateApprovalRequest(request), true)
  assert.equal(request.reason, before)
  assert.equal(typeof request.displayReason.zh, 'string')
  assert.equal(typeof request.displayReason.en, 'string')
})

test('applyQuestionRewrites: 合法的改写被应用，label 保持原样', () => {
  const questions = [
    {
      id: 'q1',
      question: 'Which sandbox mode should the retry use?',
      header: 'Mode',
      options: [
        { label: 'workspace-write', description: 'Write inside the workspace only' },
        { label: 'danger-full-access', description: 'No sandbox at all' },
      ],
      multi_select: false,
    },
  ]
  const rewritten = [
    {
      id: 'q1',
      question: '这次重试用哪种权限？',
      header: '权限',
      options: [
        { label: 'workspace-write', description: '只能写工作区里的文件' },
        { label: 'danger-full-access', description: '完全不限制' },
      ],
    },
  ]
  assert.equal(applyQuestionRewrites(questions, rewritten), true)
  assert.equal(questions[0].question, '这次重试用哪种权限？')
  assert.equal(questions[0].header, '权限')
  assert.equal(questions[0].options[0].label, 'workspace-write')
  assert.equal(questions[0].options[1].description, '完全不限制')
  assert.equal(questions[0].multi_select, false)
})

test('applyQuestionRewrites: label / id / 数量对不上时整体拒绝', () => {
  const questions = [{ id: 'q1', question: 'Q?', options: [{ label: 'A' }, { label: 'B' }] }]
  const badLabel = [{ id: 'q1', question: '问题？', options: [{ label: 'a' }, { label: 'B' }] }]
  const badId = [{ id: 'q2', question: '问题？', options: [{ label: 'A' }, { label: 'B' }] }]
  const badCount = [{ id: 'q1', question: '问题？', options: [{ label: 'A' }] }]
  assert.equal(applyQuestionRewrites(questions, badLabel), false)
  assert.equal(applyQuestionRewrites(questions, badId), false)
  assert.equal(applyQuestionRewrites(questions, badCount), false)
  assert.equal(questions[0].question, 'Q?')
})

test('applyQuestionRewrites: 非中文 label 可以补解释，中文 label 不行', () => {
  const englishLabel = [{ id: 'q1', question: 'Q?', options: [{ label: 'workspace-write' }] }]
  const withExplanation = [
    { id: 'q1', question: '问题？', options: [{ label: 'workspace-write', description: '只能写工作区里的文件' }] },
  ]
  assert.equal(applyQuestionRewrites(englishLabel, withExplanation), true)
  assert.equal(englishLabel[0].options[0].description, '只能写工作区里的文件')

  const chineseLabel = [{ id: 'q1', question: 'Q?', options: [{ label: '继续' }] }]
  const extra = [{ id: 'q1', question: '问题？', options: [{ label: '继续', description: '凭空加的说明' }] }]
  assert.equal(applyQuestionRewrites(chineseLabel, extra), false)
  assert.equal(chineseLabel[0].options[0].description, undefined)

  const hadDescription = [{ id: 'q1', question: 'Q?', options: [{ label: '继续', description: '原说明' }] }]
  const dropped = [{ id: 'q1', question: '问题？', options: [{ label: '继续' }] }]
  assert.equal(applyQuestionRewrites(hadDescription, dropped), false)
})

test('parseRewrittenArray: 容忍代码块围栏', () => {
  const parsed = parseRewrittenArray('```json\n[{"id":"q1","question":"x"}]\n```')
  assert.deepEqual(parsed, [{ id: 'q1', question: 'x' }])
  assert.equal(parseRewrittenArray('not json'), null)
  assert.equal(parseRewrittenArray('{"id":"q1"}'), null)
})

test('buildRewritePrompt: 含铁律与输入 JSON', () => {
  const prompt = buildRewritePrompt([{ id: 'q1', question: 'Q?' }])
  assert.match(prompt, /label/)
  assert.match(prompt, /只输出 JSON/)
  assert.match(prompt, /"q1"/)
})

test('needsRewrite: 只看会展示的文字，已是中文就不改', () => {
  assert.equal(needsRewrite({ id: 'q', question: 'Continue?' }), true)
  assert.equal(needsRewrite({ id: 'q', question: '继续吗？' }), false)
  assert.equal(
    needsRewrite({ id: 'q', question: '继续吗？', options: [{ label: 'yes', description: 'Keep going' }] }),
    true,
  )
  assert.equal(
    needsRewrite({ id: 'q', question: '继续吗？', options: [{ label: 'yes', description: '继续做' }] }),
    false,
  )
  assert.equal(needsRewrite(null), false)
})

function fakeCtx(chunks, { throwOnStream = false } = {}) {
  const state = { streams: [] }
  const ctx = {
    get(service) {
      if (service !== 'llm') return undefined
      return {
        listProviders: () => ['deepseek-account'],
        stream(request) {
          state.streams.push(request)
          if (throwOnStream) throw new Error('boom')
          return (async function* () {
            for (const chunk of chunks) yield chunk
          })()
        },
      }
    },
  }
  return { ctx, state }
}

test('rewriteQuestions: 成功时改写并保留 label', async () => {
  const answer = JSON.stringify([
    {
      id: 'q1',
      question: '要不要继续？',
      options: [{ label: 'yes', description: '继续做' }, { label: 'no', description: '停下来' }],
    },
  ])
  const { ctx, state } = fakeCtx([
    { type: 'text-delta', text: answer.slice(0, 10) },
    { type: 'text-delta', text: answer.slice(10) },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  const request = {
    agent: { options: { provider: 'deepseek-account', model: 'deepseek-flash' } },
    questions: [{
      id: 'q1',
      question: 'Continue?',
      options: [
        { label: 'yes', description: 'Keep going' },
        { label: 'no', description: 'Stop here' },
      ],
    }],
  }
  assert.equal(await rewriteQuestions(ctx, request), true)
  assert.equal(request.questions[0].question, '要不要继续？')
  assert.equal(request.questions[0].options[0].label, 'yes')
  assert.equal(state.streams.length, 1)
})

test('rewriteQuestions: 相同内容第二次命中缓存，不再调用模型', async () => {
  const answer = JSON.stringify([{ id: 'qc', question: '缓存命中测试？' }])
  const { ctx, state } = fakeCtx([
    { type: 'text-delta', text: answer },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  const make = () => ({ agent: { options: {} }, questions: [{ id: 'qc', question: 'Cache hit test?' }] })
  const first = make()
  const second = make()
  assert.equal(await rewriteQuestions(ctx, first), true)
  assert.equal(await rewriteQuestions(ctx, second), true)
  assert.equal(state.streams.length, 1)
  assert.equal(second.questions[0].question, '缓存命中测试？')
})

test('rewriteQuestions: 只读的问题对象也能改写（克隆后替换数组）', async () => {
  const answer = JSON.stringify([{ id: 'q1', question: '请继续？' }])
  const { ctx } = fakeCtx([
    { type: 'text-delta', text: answer },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  const frozenQuestions = deepFreezeValue([{ id: 'q1', question: 'Proceed?' }])
  const request = { agent: { options: {} }, questions: frozenQuestions }
  assert.equal(await rewriteQuestions(ctx, request), true)
  assert.equal(request.questions[0].question, '请继续？')
  assert.equal(frozenQuestions[0].question, 'Proceed?')
  assert.equal(Object.isFrozen(frozenQuestions[0]), true)
})

function deepFreezeValue(value) {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) deepFreezeValue(value[key])
    Object.freeze(value)
  }
  return value
}

test('rewriteQuestions: 全是中文时整批跳过，不调模型', async () => {
  const { ctx, state } = fakeCtx([{ type: 'finish', reason: { kind: 'stop' } }])
  const request = {
    agent: { options: { provider: 'deepseek-account', model: 'deepseek-flash' } },
    questions: [{ id: 'q1', question: '要继续吗？', options: [{ label: 'yes', description: '继续做' }] }],
  }
  assert.equal(await rewriteQuestions(ctx, request), false)
  assert.equal(state.streams.length, 0)
  assert.equal(request.questions[0].question, '要继续吗？')
})

test('rewriteQuestions: 混合语言时只交非中文的问题给模型', async () => {
  const answer = JSON.stringify([{ id: 'q2', question: '请继续？' }])
  const { ctx, state } = fakeCtx([
    { type: 'text-delta', text: answer },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  const request = {
    agent: { options: { provider: 'deepseek-account', model: 'deepseek-flash' } },
    questions: [
      { id: 'q1', question: '要继续吗？' },
      { id: 'q2', question: 'Proceed?' },
    ],
  }
  assert.equal(await rewriteQuestions(ctx, request), true)
  const prompt = state.streams[0].messages[0].content[0].text
  assert.match(prompt, /q2/)
  assert.doesNotMatch(prompt, /q1/)
  assert.equal(request.questions[0].question, '要继续吗？')
  assert.equal(request.questions[1].question, '请继续？')
})

test('rewriteQuestions: 无 agent / 模型报错 / 输出不合法时保持原样', async () => {
  const { ctx } = fakeCtx([{ type: 'finish', reason: { kind: 'error' } }])

  const noAgent = { questions: [{ id: 'q1', question: 'Continue?' }] }
  assert.equal(await rewriteQuestions(ctx, noAgent), false)

  const errorCtx = fakeCtx([{ type: 'finish', reason: { kind: 'error' } }])
  const withAgent = { agent: { options: {} }, questions: [{ id: 'q1', question: 'Continue?' }] }
  assert.equal(await rewriteQuestions(errorCtx.ctx, withAgent), false)
  assert.equal(withAgent.questions[0].question, 'Continue?')

  const badCtx = fakeCtx([{ type: 'text-delta', text: '{"oops":true}' }, { type: 'finish', reason: { kind: 'stop' } }])
  const bad = { agent: { options: {} }, questions: [{ id: 'q1', question: 'Continue?' }] }
  assert.equal(await rewriteQuestions(badCtx.ctx, bad), false)
  assert.equal(bad.questions[0].question, 'Continue?')

  const throwing = fakeCtx([], { throwOnStream: true })
  const th = { agent: { options: {} }, questions: [{ id: 'q1', question: 'Continue?' }] }
  assert.equal(await rewriteQuestions(throwing.ctx, th), false)
})

test('apply: 注册四个监听器，pre-execute 缓存参数供审批分级使用', () => {
  const registered = []
  const ctx = {
    on(event, listener, options) {
      registered.push({ event, listener, options })
      return () => {}
    },
  }
  apply(ctx)
  const byEvent = (event) => registered.find((entry) => entry.event === event)
  assert.equal(registered.length, 4)
  assert.deepEqual(byEvent('tools/pre-execute').options, { prepend: true, global: true })
  assert.deepEqual(byEvent('approval/request').options, { prepend: true, global: true })
  assert.deepEqual(byEvent('user-questions/request').options, { prepend: true, global: true })
  assert.equal(byEvent('tools/result').event, 'tools/result')

  const exec = { callId: 'apply-call', name: 'write', arguments: { file_path: 'C:/tmp/applied.txt' } }
  assert.deepEqual(byEvent('tools/pre-execute').listener(exec, () => ({ kind: 'allow' })), { kind: 'allow' })
  const request = {
    toolName: 'write',
    callId: 'apply-call',
    reason: 'escalate sandbox to danger-full-access: 应用配置',
  }
  const outcome = byEvent('approval/request').listener(request, () => 'unavailable')
  assert.equal(outcome, 'unavailable')
  assert.match(request.displayReason.zh, /⚠️ 会写入文件/)
  assert.match(request.displayReason.zh, /C:\/tmp\/applied\.txt/)

  byEvent('tools/result').listener(exec)
  const afterCleanup = {
    toolName: 'write',
    callId: 'apply-call',
    reason: 'escalate sandbox to danger-full-access: 应用配置',
  }
  byEvent('approval/request').listener(afterCleanup, () => 'unavailable')
  assert.doesNotMatch(afterCleanup.displayReason.zh, /C:\/tmp\/applied\.txt/)
  assert.match(afterCleanup.displayReason.zh, /没能从参数里确定具体路径/)
})
