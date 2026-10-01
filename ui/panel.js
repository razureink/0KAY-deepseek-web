// DeepSeek 网页版 · 自定义设置面板（Core 以 stdio 承载的 provider 插件）
// 由 PluginModulePane 作为设置 tab 的模块加载；通过 importmap 使用宿主 Vue。
import { defineComponent, h, reactive, ref, onMounted } from 'vue'

const SECTION = 'deepseek-web'
const PROBE_URL = '/api/stdio-provider/deepseek-web/v1/probe'

const DEFAULTS = {
  token: '',
  auth_file: '',
  default_model: 'deepseek-web-chat',
  max_prompt_chars: 400000,
  min_request_interval_ms: 2000,
  max_request_interval_ms: 4000,
  allow_concurrent: false,
  idle_timeout_ms: 120000,
  auto_continue: true,
  max_continuations: 2,
  session_cleanup: 'deferred',
  probe_interval_ms: 1800000,
  max_ref_images: 24,
  context_mode: 'full',
}

export default defineComponent({
  name: 'DeepSeekWebSettings',
  setup() {
    const values = reactive({ ...DEFAULTS })
    const loading = ref(true)
    const saving = ref(false)
    const saved = ref(false)
    const error = ref('')
    const probe = ref('')

    async function load() {
      loading.value = true
      error.value = ''
      try {
        const res = await fetch(`/api/settings/${SECTION}`)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.json()
        Object.assign(values, DEFAULTS, data.values || {})
      } catch (e) {
        error.value = e?.message || String(e)
      } finally {
        loading.value = false
      }
    }

    async function save() {
      saving.value = true
      error.value = ''
      saved.value = false
      try {
        const body = {}
        for (const key of Object.keys(DEFAULTS)) body[key] = values[key]
        const res = await fetch(`/api/settings/${SECTION}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ values: body }),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        saved.value = true
        setTimeout(() => { saved.value = false }, 2000)
      } catch (e) {
        error.value = e?.message || String(e)
      } finally {
        saving.value = false
      }
    }

    async function testConnectivity() {
      probe.value = '测试中…'
      try {
        const res = await fetch(PROBE_URL, { method: 'POST' })
        const data = await res.json()
        probe.value = data.ok ? `已登录：${data.account || 'ok'}` : `未登录：${data.error || '未知'}`
      } catch (e) {
        probe.value = `失败：${e?.message || e}`
      }
    }

    onMounted(load)

    const plain = (key, label, help, type = 'text') => h('label', { class: 'dw-field' }, [
      h('span', { class: 'dw-label' }, label),
      h('input', { class: 'dw-input', type, value: values[key], onInput: (e) => { values[key] = type === 'number' ? Number(e.target.value) : e.target.value } }),
      help ? h('span', { class: 'dw-help' }, help) : null,
    ])
    const number = (key, label, help) => plain(key, label, help, 'number')
    const select = (key, label, options, help) => h('label', { class: 'dw-field' }, [
      h('span', { class: 'dw-label' }, label),
      h('select', { class: 'dw-input', value: values[key], onChange: (e) => { values[key] = e.target.value } },
        options.map((o) => h('option', { value: o }, o))),
      help ? h('span', { class: 'dw-help' }, help) : null,
    ])
    const toggle = (key, label, help) => h('label', { class: 'dw-toggle' }, [
      h('input', { type: 'checkbox', checked: !!values[key], onChange: (e) => { values[key] = e.target.checked } }),
      h('span', { class: 'dw-toggle-label' }, label),
      help ? h('span', { class: 'dw-help' }, help) : null,
    ])
    const row = (...children) => h('div', { class: 'dw-row' }, children)
    const card = (title, desc, children) => h('section', { class: 'dw-card' }, [
      h('div', { class: 'dw-card-head' }, [h('h3', {}, title), desc ? h('p', {}, desc) : null]),
      h('div', { class: 'dw-card-body' }, children),
    ])

    return () => h('div', { class: 'deepseek-web-panel' }, [
      h('header', { class: 'dw-head' }, [
        h('div', {}, [
          h('h2', {}, 'DeepSeek 网页版'),
          h('p', { class: 'dw-sub' }, '用 chat.deepseek.com 网页登录态作为模型通道；由 Core 以 stdio 子进程承载，不占用端口。'),
        ]),
        h('div', { class: 'dw-head-actions' }, [
          h('button', { class: 'dw-btn tonal', onClick: testConnectivity }, '连通性测试'),
        ]),
      ]),
      probe.value ? h('div', { class: 'dw-probe' }, probe.value) : null,
      error.value ? h('div', { class: 'dw-error' }, error.value) : null,
      saved.value ? h('div', { class: 'dw-ok' }, '已保存') : null,
      loading.value ? h('p', { class: 'dw-hint' }, '加载中…') : h('div', { class: 'dw-cards' }, [
        card('账号', '登录态来源：优先 Bearer Token，其次凭据文件。', [
          plain('token', 'Bearer Token', 'F12 从 chat.deepseek.com 请求里取 Authorization；留空则用凭据文件。'),
          plain('auth_file', '凭据文件', 'DSH 捕获的 deepseek-auth.json 路径；留空默认 ~/.dsh/web-login/deepseek-auth.json。'),
        ]),
        card('模型', null, [
          select('default_model', '默认模型', ['deepseek-web-chat', 'deepseek-web-reasoner'], '未指定模型时使用；chat=不推理，reasoner=thinking。'),
        ]),
        card('防风控', '同一账号并发会被网页端临时封禁，默认串行。', [
          row(number('min_request_interval_ms', '请求间隔下限 (ms)', null), number('max_request_interval_ms', '请求间隔上限 (ms)', null)),
          select('session_cleanup', '临时会话清理', ['deferred', 'immediate', 'keep'], 'keep=不删（网页端会留临时会话）。'),
          number('probe_interval_ms', '登录态探活间隔 (ms)', '只读 users/current，零额度；0=关闭。'),
          toggle('allow_concurrent', '允许并发', '不建议：会显著提高被限流风险。'),
        ]),
        card('上下文与流', null, [
          number('max_prompt_chars', 'Prompt 字符上限', '超出走中段截断；调高更易被限流。'),
          number('idle_timeout_ms', '流空闲超时 (ms)', null),
          row(toggle('auto_continue', '自动续写', null), number('max_continuations', '最大续写轮数', null)),
          select('context_mode', '上下文投喂', ['full', 'chained'], 'full=每轮回发全量；chained=只发增量（需会话标识）。'),
          number('max_ref_images', '最多引用图片数', '一次请求随附的图片上限。'),
        ]),
      ]),
      h('footer', { class: 'dw-foot' }, [
        h('button', { class: 'dw-btn primary', disabled: saving.value, onClick: save }, saving.value ? '保存中…' : '保存'),
      ]),
    ])
  },
})

;(() => {
  if (typeof document === 'undefined' || document.getElementById('deepseek-web-panel-style')) return
  const style = document.createElement('style')
  style.id = 'deepseek-web-panel-style'
  style.textContent = `
.deepseek-web-panel{max-width:960px;color:var(--md-on-surface)}
.deepseek-web-panel .dw-head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap;margin-bottom:18px}
.deepseek-web-panel h2{margin:0;font-size:clamp(22px,2.4vw,30px);font-weight:800;letter-spacing:-.02em}
.deepseek-web-panel .dw-sub{margin:6px 0 0;color:var(--md-on-surface-variant);font-size:14px;line-height:1.6;max-width:60ch}
.deepseek-web-panel .dw-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px}
.deepseek-web-panel .dw-card{border-radius:20px;border:1px solid var(--md-outline-variant);background:var(--md-surface-container-low);padding:18px}
.deepseek-web-panel .dw-card-head h3{margin:0;font-size:16px;font-weight:750}
.deepseek-web-panel .dw-card-head p{margin:4px 0 0;font-size:12.5px;color:var(--md-on-surface-variant)}
.deepseek-web-panel .dw-card-body{display:flex;flex-direction:column;gap:12px;margin-top:14px}
.deepseek-web-panel .dw-row{display:flex;gap:12px;flex-wrap:wrap}
.deepseek-web-panel .dw-row>*{flex:1;min-width:120px}
.deepseek-web-panel .dw-field{display:flex;flex-direction:column;gap:6px}
.deepseek-web-panel .dw-label{font-size:12px;font-weight:700;letter-spacing:.04em;color:var(--md-on-surface-variant)}
.deepseek-web-panel .dw-input{font:inherit;min-height:38px;padding:0 12px;border-radius:10px;border:1px solid var(--md-outline-variant);background:var(--md-surface-container-high);color:var(--md-on-surface);outline:none}
.deepseek-web-panel textarea.dw-input{min-height:auto;padding:10px 12px}
.deepseek-web-panel .dw-input:focus{border-color:var(--md-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--md-primary) 14%,transparent)}
.deepseek-web-panel .dw-help{font-size:11.5px;color:var(--md-on-surface-variant);line-height:1.5}
.deepseek-web-panel .dw-toggle{display:flex;align-items:center;gap:8px;font-size:13.5px;font-weight:600;color:var(--md-on-surface);flex-wrap:wrap}
.deepseek-web-panel .dw-toggle input{width:18px;height:18px;accent-color:var(--md-primary)}
.deepseek-web-panel .dw-toggle .dw-help{flex-basis:100%;font-weight:400}
.deepseek-web-panel .dw-btn{height:42px;padding:0 20px;border:1px solid transparent;border-radius:999px;font-weight:700;font-size:14px;cursor:pointer;background:var(--md-surface-container-high);color:var(--md-on-surface)}
.deepseek-web-panel .dw-btn.tonal{background:var(--md-secondary-container);color:var(--md-on-secondary-container)}
.deepseek-web-panel .dw-btn.primary{background:var(--md-primary);color:var(--md-on-primary)}
.deepseek-web-panel .dw-btn:disabled{opacity:.6;cursor:not-allowed}
.deepseek-web-panel .dw-foot{display:flex;justify-content:flex-end;margin-top:18px}
.deepseek-web-panel .dw-probe,.deepseek-web-panel .dw-error,.deepseek-web-panel .dw-ok{margin:0 0 14px;padding:12px 16px;border-radius:14px;font-size:13.5px}
.deepseek-web-panel .dw-probe{background:var(--md-secondary-container);color:var(--md-on-secondary-container)}
.deepseek-web-panel .dw-ok{background:var(--md-secondary-container);color:var(--md-on-secondary-container)}
.deepseek-web-panel .dw-error{background:var(--md-error-container);color:#410e0b}
.deepseek-web-panel .dw-hint{color:var(--md-on-surface-variant)}
`
  document.head.appendChild(style)
})()
