import { describe, it, expect, vi, beforeAll } from 'vitest'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { ToolArgsError } from '@deepseek-ai/dsh-tools'
import type { InnerTools } from '../src/facade.ts'

// 记录 apply 交给 registerFacades 的原工具，用于比对单路由注册的是否同一对象。
const captured: { inner?: InnerTools } = {}
vi.mock('../src/facade.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/facade.ts')>()
  return {
    ...actual,
    registerFacades: (inner: InnerTools, register: (tool: ToolDefinition) => void) => {
      captured.inner = inner
      actual.registerFacades(inner, register)
    },
  }
})

const { apply } = await import('../src/index.ts')
const { registerFacades, FacadeArgsError } = await import('../src/facade.ts')

const spawn = vi.fn()
const registered: ToolDefinition[] = []

function fakeCtx(): unknown {
  const noop = (): void => {}
  const services: Record<string, unknown> = {
    tools: { register: (tool: ToolDefinition) => { registered.push(tool); return noop } },
    subprocess: { spawn },
    logger: () => ({ info: noop, warn: noop, error: noop, debug: noop }),
    effect: noop,
    on: noop,
    inject: noop,
    get: () => undefined,
    settings: { register: noop },
    config: {},
  }
  return new Proxy({}, { get: (_target, key) => services[key as string] })
}

const SINGLE_ROUTE = [
  'ego_navigate', 'ego_screenshot', 'ego_http', 'ego_download',
  'ego_click', 'ego_fill', 'ego_key', 'ego_hover', 'ego_select',
  'ego_check', 'ego_drag', 'ego_scroll', 'ego_upload', 'ego_dialog',
]
// EGO-02 合并前暂按原名单路由注册。
const PENDING_MERGE = [
  'ego_snapshot', 'ego_read_element', 'ego_page_info', 'ego_js', 'ego_cdp', 'ego_script',
  'ego_space_open', 'ego_space_close', 'ego_auth_flush', 'ego_doctor', 'ego_status',
]
const REMOVED = [
  'ego_wait_for_selector', 'ego_wait_for_url', 'ego_wait_for_response',
  'ego_cli', 'ego_help', 'ego_login_import', 'ego_captcha',
]

const exec = { signal: new AbortController().signal } as unknown as ToolRunContext
const egoWait = (): ToolDefinition => registered.find((tool) => tool.name === 'ego_wait')!

beforeAll(() => {
  apply(fakeCtx() as Parameters<typeof apply>[0], {})
})

describe('registerFacades via apply', () => {
  it('registers the single-route tools, ego_wait and the pending-merge tools, nothing else', () => {
    const names = registered.map((tool) => tool.name)
    expect(new Set(names).size).toBe(names.length)
    expect([...names].sort()).toEqual([...SINGLE_ROUTE, ...PENDING_MERGE, 'ego_wait'].sort())
  })

  it('S4: single-route tools are the collected ToolDefinition objects themselves', () => {
    expect(captured.inner?.size).toBe(33)
    for (const name of [...SINGLE_ROUTE, ...PENDING_MERGE]) {
      expect(registered.find((tool) => tool.name === name)).toBe(captured.inner!.get(name))
    }
  })

  it('S2: merged-away and excluded tool names are not registered', () => {
    const names = new Set(registered.map((tool) => tool.name))
    for (const name of REMOVED) expect(names.has(name)).toBe(false)
  })

  it('S3: ego_wait is a new tool with a required action enum over the 4 wait routes', () => {
    const tool = egoWait()
    expect(tool).not.toBe(captured.inner!.get('ego_wait'))
    const parameters = tool.parameters as { properties: Record<string, { enum?: string[] }>; required?: string[] }
    expect(parameters.properties.action.enum).toEqual(['time', 'selector', 'url', 'response'])
    expect(parameters.required).toEqual(['action'])
    expect(Object.keys(parameters.properties).sort()).toEqual(
      ['action', 'body', 'ms', 'pattern', 'selector', 'space', 'state', 'timeout', 'url'].sort(),
    )
    expect(tool.timeoutMs).toBe(captured.inner!.get('ego_wait_for_selector')!.timeoutMs)
    expect(tool.presentCall?.({ action: 'url', pattern: '/x' })).toMatchObject({ title: 'ego_wait · url' })
  })
})

describe('ego_wait dispatch errors', () => {
  it('D1: missing required argument fails via the original tool without spawning', async () => {
    spawn.mockClear()
    const err = await egoWait().execute({ action: 'selector' }, exec).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ToolArgsError)
    expect((err as Error).message).toContain('selector')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('D2: argument not belonging to the action is rejected and accepted ones listed', async () => {
    spawn.mockClear()
    const err = await egoWait().execute({ action: 'time', ms: 10, selector: '#a' }, exec).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(FacadeArgsError)
    expect((err as InstanceType<typeof FacadeArgsError>).code).toBe('param_not_allowed')
    expect((err as InstanceType<typeof FacadeArgsError>).accepted).toEqual(['ms'])
    expect((err as Error).message).toContain('selector')
    expect((err as Error).message).toContain('ms')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('D3: unknown action is rejected with all action values listed', async () => {
    spawn.mockClear()
    const err = await egoWait().execute({ action: 'idle' }, exec).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(FacadeArgsError)
    expect((err as InstanceType<typeof FacadeArgsError>).code).toBe('unknown_action')
    for (const action of ['time', 'selector', 'url', 'response']) expect((err as Error).message).toContain(action)
    expect(spawn).not.toHaveBeenCalled()
  })
})

describe('ego_wait routing', () => {
  it('S3: each action reaches its original tool with action stripped and the result unchanged', async () => {
    const inner = new Map<string, ToolDefinition>()
    for (const [name, tool] of captured.inner!) {
      inner.set(name, { ...tool, execute: vi.fn(async (args: unknown) => ({ ok: true, via: name, args })) })
    }
    const out: ToolDefinition[] = []
    registerFacades(inner, (tool) => out.push(tool))
    const wait = out.find((tool) => tool.name === 'ego_wait')!
    const rows: Array<[Record<string, unknown>, string]> = [
      [{ action: 'time', ms: 5 }, 'ego_wait'],
      [{ action: 'selector', selector: '#a', state: 'hidden' }, 'ego_wait_for_selector'],
      [{ action: 'url', pattern: '/done', timeout: 100 }, 'ego_wait_for_url'],
      [{ action: 'response', url: '/api', body: 'json' }, 'ego_wait_for_response'],
    ]
    for (const [args, target] of rows) {
      const { action: _action, ...rest } = args
      await expect(wait.execute(args, exec)).resolves.toEqual({ ok: true, via: target, args: rest })
      expect(inner.get(target)!.execute).toHaveBeenCalledWith(rest, exec)
    }
  })
})

describe('coverage check', () => {
  it('D5: a collected tool missing from FACADES and EXCLUDED fails registration with its name', () => {
    const inner = new Map(captured.inner!)
    inner.set('ego_fake', { ...captured.inner!.get('ego_wait')!, name: 'ego_fake' })
    expect(() => registerFacades(inner, () => {})).toThrow(/ego_fake/)
  })
})
