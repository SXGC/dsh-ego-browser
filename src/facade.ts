/**
 * 外层工具：把收集到的原 `ego_*` 工具按路由表包装后注册给宿主。
 *
 * 单路由条目直接注册原 `ToolDefinition`；多路由条目以 `action` 参数选择原工具。
 * 原工具的实现（参数校验、串行锁、重试、任务空间跟踪）不经外层重写。
 */
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'

/** 收集到的原工具，以原名为键。值是 `defineTool` 的返回值，未注册到宿主。 */
export type InnerTools = ReadonlyMap<string, ToolDefinition>

/**
 * 一个外层工具。
 * - `routes` 只有一项时为单路由：注册原 `ToolDefinition` 本身，`name` 等于原名。
 * - 多项时为多路由：注册新 `ToolDefinition`，`action` 选择原工具。
 * 每条路由允许的参数与必填参数从原工具的 `parameters` 推导，不在本表另存。
 */
export interface FacadeSpec {
  readonly name: string
  /** 单路由时省略，沿用原描述。多路由时必填，可引用原描述片段。 */
  readonly description?: (inner: InnerTools) => string
  /** `action` 取值 → 原工具名。 */
  readonly routes: Readonly<Record<string, string>>
  /** 省略 `action` 时使用的取值。省略本字段表示 `action` 必填。 */
  readonly defaultAction?: string
  /**
   * 同名参数在多条路由里描述不同时，外层使用的描述。
   * 同名参数类型不同属于设计错误：`buildFacade` 抛错。
   */
  readonly paramDescriptions?: Readonly<Record<string, string>>
}

const single = (name: string): FacadeSpec => ({ name, routes: { _: name } })

/**
 * 外层描述中的一行：`- <action> (<原工具参数>): <原工具描述>`。
 * 原描述引用了不再注册的工具名时，用 `text` 代替原描述。
 */
const routeLine = (inner: InnerTools, action: string, toolName: string, text?: string): string => {
  const tool = inner.get(toolName)
  const params = tool === undefined ? [] : Object.keys(propsOf(tool))
  return `- ${action} (${params.join(', ')}): ${text ?? tool?.description ?? ''}`
}

/** 外层工具。顺序即注册顺序。 */
export const FACADES: readonly FacadeSpec[] = [
  single('ego_navigate'),
  {
    name: 'ego_snapshot',
    defaultAction: 'page',
    routes: { page: 'ego_snapshot', element: 'ego_read_element', info: 'ego_page_info' },
    description: (inner) => [
      'Observe the current page in the Agent browser. Pick what to read with `action` (default: page); the other arguments are those of that action.',
      routeLine(inner, 'page', 'ego_snapshot') +
        ' The [ref=N, loc=...] selectors are the targets for ego_click, ego_fill and the other page-action tools.',
      routeLine(inner, 'element', 'ego_read_element'),
      routeLine(inner, 'info', 'ego_page_info') +
        ' When humanCheck.detected is true, tell the user to complete the verification in the Agent browser window.',
    ].join('\n'),
  },
  single('ego_screenshot'),
  // 10 个页面操作：单路由，原样注册
  ...['ego_click', 'ego_fill', 'ego_key', 'ego_hover', 'ego_select',
    'ego_check', 'ego_drag', 'ego_scroll', 'ego_upload', 'ego_dialog'].map(single),
  {
    name: 'ego_wait',
    routes: {
      time: 'ego_wait',
      selector: 'ego_wait_for_selector',
      url: 'ego_wait_for_url',
      response: 'ego_wait_for_response',
    },
    description: (inner) => [
      'Wait in the Agent browser. Pick the kind of wait with `action`; the other arguments are those of that action.',
      routeLine(inner, 'time', 'ego_wait'),
      routeLine(inner, 'selector', 'ego_wait_for_selector'),
      routeLine(inner, 'url', 'ego_wait_for_url'),
      routeLine(inner, 'response', 'ego_wait_for_response'),
    ].join('\n'),
  },
  {
    name: 'ego_eval',
    routes: { js: 'ego_js', cdp: 'ego_cdp', script: 'ego_script' },
    description: (inner) => [
      'Run code in the Agent browser. Pick how with `action`; the other arguments are those of that action.',
      routeLine(inner, 'js', 'ego_js'),
      routeLine(inner, 'cdp', 'ego_cdp'),
      // 原描述引用已不注册的 ego_cli。
      routeLine(inner, 'script', 'ego_script',
        'Run an arbitrary `ego-browser nodejs` script in ONE invocation (page/…locator/browser/taskSpaces/site/fetch/cdp preloaded) and return structured {ok, stdout, stderr, result, durationMs, timedOut}. Use for a full multi-step browser task as a single script.'),
    ].join('\n'),
  },
  single('ego_http'),
  single('ego_download'),
  {
    name: 'ego_space',
    routes: { open: 'ego_space_open', close: 'ego_space_close', flush: 'ego_auth_flush' },
    description: (inner) => [
      'Manage the Agent browser task space. Pick the operation with `action`; the other arguments are those of that action.',
      routeLine(inner, 'open', 'ego_space_open'),
      routeLine(inner, 'close', 'ego_space_close'),
      routeLine(inner, 'flush', 'ego_auth_flush'),
    ].join('\n'),
    paramDescriptions: {
      name: "Task-space name (close also accepts a numeric id). In persistent profile mode (default), ALWAYS use the single 'default' space.",
    },
  },
  {
    name: 'ego_doctor',
    defaultAction: 'full',
    routes: { full: 'ego_doctor', cli: 'ego_status' },
    description: (inner) => [
      'Diagnose the Agent browser environment. Pick the check with `action` (default: full).',
      routeLine(inner, 'full', 'ego_doctor'),
      routeLine(inner, 'cli', 'ego_status'),
    ].join('\n'),
  },
]

/** 收集到但不注册的原工具。 */
export const EXCLUDED: ReadonlySet<string> = new Set(['ego_login_import', 'ego_help', 'ego_captcha', 'ego_cli'])

/** `dispatch` 抛出的错误。`message` 面向模型，写明怎样改参数。 */
export class FacadeArgsError extends Error {
  constructor(
    readonly code: 'unknown_action' | 'param_not_allowed',
    readonly tool: string,
    /** unknown_action：全部取值；param_not_allowed：该 action 接受的参数。 */
    readonly accepted: readonly string[],
    message: string,
  ) {
    super(message)
    this.name = 'FacadeArgsError'
  }
}

/**
 * 校验覆盖，再逐个注册外层工具。
 * @throws Error 有原工具既不在任何路由中、也不在 EXCLUDED 中；或路由指向不存在的原工具（D5）。
 */
export function registerFacades(inner: InnerTools, register: (tool: ToolDefinition) => void): void {
  const routed = new Set(FACADES.flatMap((spec) => Object.values(spec.routes)))
  const unrouted = [...inner.keys()].filter((name) => !routed.has(name) && !EXCLUDED.has(name))
  if (unrouted.length > 0) {
    throw new Error(`ego facade: tools neither routed in FACADES nor listed in EXCLUDED: ${unrouted.join(', ')}`)
  }
  const missing = [...routed].filter((name) => !inner.has(name))
  if (missing.length > 0) {
    throw new Error(`ego facade: FACADES routes to tools that were not collected: ${missing.join(', ')}`)
  }
  for (const spec of FACADES) {
    const routes = Object.values(spec.routes)
    register(routes.length === 1 ? inner.get(routes[0])! : buildFacade(spec, inner))
  }
}

interface ObjectSchema {
  properties?: Record<string, Record<string, unknown>>
  required?: string[]
}

const propsOf = (tool: ToolDefinition): Record<string, Record<string, unknown>> =>
  (tool.parameters as ObjectSchema).properties ?? {}

/** 多路由调用的 action：`args.action ?? spec.defaultAction`；取值不在 routes 中时 `tool` 为 undefined。 */
const resolveRoute = (spec: FacadeSpec, inner: InnerTools, args: unknown): { action: unknown; tool: ToolDefinition | undefined } => {
  const action = (args as { action?: unknown } | null)?.action ?? spec.defaultAction
  const tool = typeof action === 'string' && Object.hasOwn(spec.routes, action) ? inner.get(spec.routes[action]) : undefined
  return { action, tool }
}

const withoutAction = (args: unknown): Record<string, unknown> => {
  const { action: _action, ...rest } = (args ?? {}) as Record<string, unknown>
  return rest
}

/**
 * 由一个多路由 FacadeSpec 构造 ToolDefinition。
 * - parameters：`action`（string enum，无 defaultAction 时 required）加各路由参数的并集；
 *   并集内不标 required，必填由原工具校验。
 * - timeoutMs：各路由原工具 timeoutMs 的最大值。
 * - output.render：交给所选原工具的 `output.render`。
 * - presentCall：标题为 `<name> · <action>`。
 */
function buildFacade(spec: FacadeSpec, inner: InnerTools): ToolDefinition {
  const actions = Object.keys(spec.routes)
  const union: Record<string, Record<string, unknown>> = {}
  const owner: Record<string, string> = {}
  for (const toolName of Object.values(spec.routes)) {
    for (const [param, schema] of Object.entries(propsOf(inner.get(toolName)!))) {
      const prev = union[param]
      if (prev === undefined) {
        union[param] = schema
        owner[param] = toolName
      } else if (JSON.stringify(prev.type) !== JSON.stringify(schema.type)) {
        throw new Error(
          `ego facade ${spec.name}: parameter "${param}" has type ${JSON.stringify(prev.type)} in ${owner[param]} but ${JSON.stringify(schema.type)} in ${toolName}`,
        )
      }
    }
  }
  for (const [param, text] of Object.entries(spec.paramDescriptions ?? {})) {
    if (union[param] !== undefined) union[param] = { ...union[param], description: text }
  }
  const actionDescription = spec.defaultAction === undefined
    ? `One of: ${actions.join(', ')}.`
    : `One of: ${actions.join(', ')}. Default: ${spec.defaultAction}.`
  const timeouts = Object.values(spec.routes)
    .map((toolName) => inner.get(toolName)!.timeoutMs)
    .filter((ms): ms is number => typeof ms === 'number')
  return {
    name: spec.name,
    description: spec.description?.(inner) ?? '',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: actions, description: actionDescription },
        ...union,
      },
      ...(spec.defaultAction === undefined ? { required: ['action'] } : {}),
    },
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
      render(args, value) {
        const { tool } = resolveRoute(spec, inner, args)
        return tool === undefined ? [{ type: 'text', text: JSON.stringify(value) }] : tool.output.render(withoutAction(args), value)
      },
    },
    ...(timeouts.length > 0 ? { timeoutMs: Math.max(...timeouts) } : {}),
    execute: (args, exec) => dispatch(spec, inner, (args ?? {}) as Record<string, unknown>, exec),
    presentCall(args) {
      const { action } = resolveRoute(spec, inner, args)
      return {
        card: 'generic',
        title: typeof action === 'string' ? `${spec.name} · ${action}` : spec.name,
        kind: 'other',
        rawInput: null,
      }
    },
  } as ToolDefinition
}

/**
 * 一次多路由调用：
 * 1. 取 `args.action ?? spec.defaultAction`；不在 routes 中 → FacadeArgsError('unknown_action')（D3）。
 * 2. 其余参数名不属于该路由原工具的 `parameters.properties` → FacadeArgsError('param_not_allowed')（D2）。
 * 3. 去掉 `action`，原样调用 `innerTool.execute(rest, exec)`，返回其结果。
 *    必填与类型由原工具校验（D1）；`markEgoToolCall`、`withEgoLock`、任务空间跟踪都在原 execute 内（D4）。
 * 不加锁、不重试、不改写返回值。
 */
async function dispatch(spec: FacadeSpec, inner: InnerTools, args: Record<string, unknown>, exec: ToolRunContext): Promise<unknown> {
  const actions = Object.keys(spec.routes)
  const { action, tool } = resolveRoute(spec, inner, args)
  if (tool === undefined) {
    throw new FacadeArgsError(
      'unknown_action',
      spec.name,
      actions,
      `${spec.name}: unknown action ${JSON.stringify(action)}. Use one of: ${actions.join(', ')}.`,
    )
  }
  const rest = withoutAction(args)
  const accepted = Object.keys(propsOf(tool))
  const extra = Object.keys(rest).filter((param) => !accepted.includes(param))
  if (extra.length > 0) {
    throw new FacadeArgsError(
      'param_not_allowed',
      spec.name,
      accepted,
      `${spec.name} action "${action}" does not accept: ${extra.join(', ')}. Accepted arguments: action, ${accepted.join(', ')}.`,
    )
  }
  return tool.execute(rest, exec)
}
