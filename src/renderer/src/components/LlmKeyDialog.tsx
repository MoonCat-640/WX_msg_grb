/**
 * LLM API Key 配置（需求「模块 5 / 软件功能 第 4 点」）
 * ------------------------------------------------------------------
 * 需求原文：
 *   「弹出对话框，支持选择 DeepSeek、ChatGPT、Qwen、文心一言、Gemini、Claude，
 *     用户输入 API Key，程序自动检测可用性；可用则调用该平台价格最低的模型，
 *     不可用则提示。」
 *
 * 实现要点：
 *   - 打开时并行拉「平台清单」与「已保存的 Key」，两者互不阻塞。
 *   - 平台清单里的 models 已按价格从低到高排好（见 shared/types.ts 的
 *     LlmProviderDescriptor），因此 models[0] 就是该平台最便宜的模型，
 *     defaultModel 也指向它 —— 界面默认就选中它，符合需求。
 *   - Key 展示只用主进程给的 maskedKey（形如 sk-****abcd），明文永不出主进程。
 */
import { useEffect, useState, type JSX } from 'react'
import type { LlmKeyRecord, LlmProviderDescriptor, LlmProviderId } from '@shared/types'
import type { LlmKeyDialogProps } from './contracts'
import { api, toast, tryCall } from '../api'
import { Button, EmptyState, Field, Modal, Select, Spinner } from './primitives'
import { Icon } from './icons'

/** 测试结果：成功失败都放进同一条 notice 里展示 */
interface TestResult {
  ok: boolean
  message: string
  model?: string
  latencyMs?: number
}

export function LlmKeyDialog({ open, onClose, onChanged, firstRun }: LlmKeyDialogProps): JSX.Element {
  const [providers, setProviders] = useState<LlmProviderDescriptor[]>([])
  const [keys, setKeys] = useState<LlmKeyRecord[]>([])
  const [loading, setLoading] = useState(false)

  const [selectedId, setSelectedId] = useState<LlmProviderId | null>(null)
  /** 是否处于「重新填写」状态：已保存的 Key 默认只读展示 */
  const [editing, setEditing] = useState(false)
  const [keyInput, setKeyInput] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [model, setModel] = useState('')
  const [testResult, setTestResult] = useState<TestResult | null>(null)
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)

  const selected = selectedId ? providers.find((p) => p.id === selectedId) ?? null : null
  const saved = selectedId ? keys.find((k) => k.provider === selectedId) ?? null : null

  /* ---------------- 加载 ---------------- */

  useEffect(() => {
    if (!open) return
    let alive = true
    setLoading(true)
    void (async () => {
      // 两个请求互不依赖，并行发出；tryCall 保证任一失败都有中文提示
      const [provs, ks] = await Promise.all([
        tryCall(() => api.llmProviders(), '加载 LLM 平台清单'),
        tryCall(() => api.llmKeys(), '读取已保存的 Key')
      ])
      if (!alive) return
      if (provs) setProviders(provs)
      if (ks) setKeys(ks)
      setLoading(false)
    })()
    return () => {
      alive = false
    }
  }, [open])

  // 关闭时清空选择，下次打开回到平台网格
  useEffect(() => {
    if (open) return
    setSelectedId(null)
    setEditing(false)
    setKeyInput('')
    setShowKey(false)
    setTestResult(null)
  }, [open])

  /* ---------------- 动作 ---------------- */

  const selectProvider = (p: LlmProviderDescriptor): void => {
    const rec = keys.find((k) => k.provider === p.id) ?? null
    setSelectedId(p.id)
    // 已保存过就先进只读态，用户想改再点「重新填写」
    setEditing(!rec)
    setKeyInput('')
    setShowKey(false)
    setModel(rec?.model ?? p.defaultModel)
    setTestResult(null)
  }

  const runTest = async (): Promise<void> => {
    if (!selected) return
    setTesting(true)
    const res = await tryCall(
      () =>
        api.llmTestKey({
          provider: selected.id,
          // 只读态用已保存的 Key（主进程内存里那份），重新填写时用输入框内容
          apiKey: editing ? keyInput.trim() || undefined : undefined,
          model
        }),
      '测试连接'
    )
    setTesting(false)
    if (res) setTestResult(res)
  }

  const save = async (): Promise<void> => {
    if (!selected) return
    if (!keyInput.trim()) {
      toast('warn', '请先填写 API Key')
      return
    }
    setSaving(true)
    const res = await tryCall(
      () => api.llmSaveKey({ provider: selected.id, apiKey: keyInput.trim(), model }),
      '保存 API Key'
    )
    setSaving(false)
    if (!res) return

    setTestResult({ ok: res.testOk, message: res.testMessage })
    // 重新拉一次，拿到最新的打码 Key 与校验时间
    const refreshed = await tryCall(() => api.llmKeys(), '刷新已保存的 Key')
    if (refreshed) setKeys(refreshed)
    setEditing(false)
    setKeyInput('')
    setShowKey(false)
    onChanged()

    if (res.testOk) toast('ok', `已保存并启用 ${selected.label}`)
    else toast('warn', `${selected.label} 的 Key 已保存，但测试未通过`)
  }

  /* ---------------- 渲染：平台网格 ---------------- */

  const renderGrid = (): JSX.Element => (
    <div className="llm-grid">
      {providers.map((p) => {
        const rec = keys.find((k) => k.provider === p.id) ?? null
        const cheapest = p.models[0]
        return (
          <button
            key={p.id}
            type="button"
            className={['llm-card', selectedId === p.id ? 'is-active' : ''].join(' ')}
            onClick={() => selectProvider(p)}
          >
            <span className="llm-card-color" style={{ background: p.color }} />
            <span className="llm-card-name">{p.label}</span>
            {rec && (
              <span className={['llm-card-ok', rec.ok ? 'is-ok' : 'is-bad'].join(' ')}>
                <Icon.Check size={13} />
              </span>
            )}
            {cheapest && (
              <>
                <span className="llm-card-model ellipsis">{cheapest.label}</span>
                <span className="llm-card-price">输入 ¥{cheapest.inputPricePerM}/百万</span>
              </>
            )}
            {rec && <span className="llm-card-masked mono ellipsis">{rec.maskedKey}</span>}
          </button>
        )
      })}
    </div>
  )

  /* ---------------- 渲染：配置区 ---------------- */

  const renderConfig = (p: LlmProviderDescriptor): JSX.Element => {
    const rec = keys.find((k) => k.provider === p.id) ?? null
    const options = p.models.map((m) => ({
      value: m.id,
      label: `${m.label} · 输入 ¥${m.inputPricePerM}/百万token`
    }))

    return (
      <div className="llm-config">
        <div className="llm-config-head">
          <span className="llm-card-color" style={{ background: p.color }} />
          <span className="llm-config-name">{p.label}</span>
          {rec?.ok && <span className="llm-config-ok">已配置</span>}
          <div className="grow" />
          <Button
            variant="link"
            size="sm"
            title={p.consoleUrl}
            onClick={() => void tryCall(() => api.openExternal(p.consoleUrl), '打开申请页面')}
          >
            <Icon.Link size={13} /> 去申请 Key
          </Button>
        </div>

        {rec && !editing ? (
          <div className="llm-key-row">
            <span className="llm-key-masked mono">{rec.maskedKey}</span>
            <div className="grow" />
            <Button size="sm" variant="subtle" onClick={() => setEditing(true)}>
              重新填写
            </Button>
            <Button size="sm" variant="subtle" loading={testing} onClick={() => void runTest()}>
              测试连接
            </Button>
          </div>
        ) : (
          <Field
            label="API Key"
            required
            hint={p.keyHint}
          >
            <div className="llm-key-row">
              <div className="llm-key-input">
                <input
                  type={showKey ? 'text' : 'password'}
                  value={keyInput}
                  placeholder={p.keyHint}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => setKeyInput(e.target.value)}
                />
                {/* 显示/隐藏切换：暗色界面下用户需要确认自己粘对了 Key */}
                <button
                  type="button"
                  className="llm-eye"
                  title={showKey ? '隐藏' : '显示'}
                  onClick={() => setShowKey((v) => !v)}
                >
                  {showKey ? <Icon.EyeOff size={15} /> : <Icon.Eye size={15} />}
                </button>
              </div>
              <Button size="sm" variant="primary" loading={saving} onClick={() => void save()}>
                保存并测试
              </Button>
            </div>
          </Field>
        )}

        <Field label="选用模型">
          <Select value={model} options={options} onChange={setModel} />
        </Field>
        <div className="llm-price-hint">默认已选该平台价格最低的模型</div>

        {!p.implemented && (
          <div className="notice notice-warn">
            <span className="notice-icon">
              <Icon.Warn size={14} />
            </span>
            <span>该平台的真实调用尚未接入（占位实现），此处只会记录你的 Key 与所选模型。</span>
          </div>
        )}

        {testResult && (
          <div className={['notice', testResult.ok ? 'notice-ok' : 'notice-danger'].join(' ')}>
            <span className="notice-icon">
              {testResult.ok ? <Icon.Check size={14} /> : <Icon.Warn size={14} />}
            </span>
            <span>
              {testResult.ok
                ? `连接成功 · 模型 ${testResult.model ?? model} · 耗时 ${testResult.latencyMs ?? '—'}ms`
                : testResult.message}
            </span>
          </div>
        )}
      </div>
    )
  }

  /* ---------------- 主体 / 底栏 ---------------- */

  const body = (
    <div className="llm-body">
      {/* 安全说明固定展示：涉及密钥，必须让用户知道存到哪、是否外传 */}
      <div className="notice llm-security">
        <span className="notice-icon">
          <Icon.Key size={14} />
        </span>
        <span>
          API Key 使用 PBKDF2 派生的密钥加密后保存在本机，不会上传到任何第三方；日志中一律打码显示。
        </span>
      </div>

      {loading && providers.length === 0 ? (
        <div className="llm-loading">
          <Spinner size={18} /> 正在读取平台清单…
        </div>
      ) : providers.length === 0 ? (
        <EmptyState icon={Icon.Robot} title="没有可用的 LLM 平台" description="平台清单为空，请检查主进程配置。" />
      ) : (
        <>
          {renderGrid()}
          {selected ? (
            renderConfig(selected)
          ) : (
            <div className="llm-hint">选择一个平台以填写 API Key；可用平台会调用其价格最低的模型。</div>
          )}
        </>
      )}
    </div>
  )

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="配置 LLM API Key"
      subtitle="选择平台并填入 Key，程序会自动测试可用性并选用价格最低的模型"
      width={680}
      footer={
        firstRun ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              稍后再说
            </Button>
            <div className="grow" />
            <Button variant="primary" onClick={onClose}>
              完成
            </Button>
          </>
        ) : (
          <Button variant="primary" onClick={onClose}>
            关闭
          </Button>
        )
      }
    >
      {body}
    </Modal>
  )
}
