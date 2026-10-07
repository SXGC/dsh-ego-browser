import { describe, it, expect, vi, beforeAll } from 'vitest'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { ToolArgsError } from '@deepseek-ai/dsh-tools'
import type { InnerTools } from '../src/facade.ts'

// 记录 apply 交给 registerFacades 的原工具（只记第一次，即 apply 的那次），用于比对单路由注册的是否同一对象。
const captured: { inner?: InnerTools } = {}
vi.mock('../src/facade.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/facade.ts')>()
  return {
    ...actual,
    registerFacades: (inner: InnerTools, register: (tool: ToolDefinition) => void) => {
      captured.inner ??= inner
      actual.registerFacades(inner, register)
    },
  }
})

// D4：记录原工具 execute 内的 markEgoToolCall 调用次数。
const markEgoToolCall = vi.fn()
vi.mock('../src/cast-server.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/cast-server.ts')>()
  return {
    ...actual,
    markEgoToolCall: (...args: Parameters<typeof actual.markEgoToolCall>) => {
      markEgoToolCall(...args)
      actual.markEgoToolCall(...args)
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
// S1 的 19 个工具。
const S1 = [
  'ego_navigate', 'ego_snapshot', 'ego_screenshot', 'ego_wait', 'ego_eval',
  'ego_http', 'ego_download', 'ego_space', 'ego_doctor',
  'ego_click', 'ego_fill', 'ego_key', 'ego_hover', 'ego_select',
  'ego_check', 'ego_drag', 'ego_scroll', 'ego_upload', 'ego_dialog',
]
const MULTI_ROUTE = ['ego_snapshot', 'ego_wait', 'ego_eval', 'ego_space', 'ego_doctor']
const REMOVED = [
  'ego_read_element', 'ego_page_info', 'ego_js', 'ego_cdp', 'ego_script',
  'ego_space_open', 'ego_space_close', 'ego_auth_flush', 'ego_status',
  'ego_wait_for_selector', 'ego_wait_for_url', 'ego_wait_for_response',
  'ego_cli', 'ego_help', 'ego_login_import', 'ego_captcha',
]

const exec = { signal: new AbortController().signal } as unknown as ToolRunContext
const byName = (name: string): ToolDefinition => registered.find((tool) => tool.name === name)!
const egoWait = (): ToolDefinition => byName('ego_wait')

beforeAll(() => {
  apply(fakeCtx() as Parameters<typeof apply>[0], {})
})

describe('registerFacades via apply', () => {
  it('S1: registers exactly the 19 ego tools', () => {
    const names = registered.map((tool) => tool.name)
    expect(new Set(names).size).toBe(names.length)
    expect([...names].sort()).toEqual([...S1].sort())
    expect([...names].sort()).toEqual([...SINGLE_ROUTE, ...MULTI_ROUTE].sort())
  })

  it('S4: single-route tools are the collected ToolDefinition objects themselves', () => {
    expect(captured.inner?.size).toBe(33)
    for (const name of SINGLE_ROUTE) {
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

describe('multi-route facades', () => {
  it('S3: action enums and defaults; ego_snapshot defaults to page, ego_doctor to full', () => {
    const expected: Record<string, { actions: string[]; required: boolean }> = {
      ego_snapshot: { actions: ['page', 'element', 'info'], required: false },
      ego_wait: { actions: ['time', 'selector', 'url', 'response'], required: true },
      ego_eval: { actions: ['js', 'cdp', 'script'], required: true },
      ego_space: { actions: ['open', 'close', 'flush'], required: true },
      ego_doctor: { actions: ['full', 'cli'], required: false },
    }
    for (const [name, { actions, required }] of Object.entries(expected)) {
      const tool = byName(name)
      expect(tool).not.toBe(captured.inner!.get(name))
      const parameters = tool.parameters as { properties: Record<string, { enum?: string[] }>; required?: string[] }
      expect(parameters.properties.action.enum).toEqual(actions)
      expect(parameters.required?.includes('action') ?? false).toBe(required)
    }
    expect(byName('ego_space').timeoutMs).toBe(120_000)
    expect(byName('ego_doctor').timeoutMs).toBe(captured.inner!.get('ego_doctor')!.timeoutMs)
  })

  it('S3/S5: each action reaches its original tool with action stripped and the result unchanged', async () => {
    const inner = new Map<string, ToolDefinition>()
    for (const [name, tool] of captured.inner!) {
      inner.set(name, { ...tool, execute: vi.fn(async (args: unknown) => ({ ok: true, via: name, args })) })
    }
    const out: ToolDefinition[] = []
    registerFacades(inner, (tool) => out.push(tool))
    const rows: Array<[string, Record<string, unknown>, string]> = [
      ['ego_snapshot', { action: 'page', scope: 'only_within_viewport' }, 'ego_snapshot'],
      ['ego_snapshot', { scope: 'full_page' }, 'ego_snapshot'],
      ['ego_snapshot', { action: 'element', selector: '#a', what: 'html' }, 'ego_read_element'],
      ['ego_snapshot', { action: 'info', space: 'default' }, 'ego_page_info'],
      ['ego_wait', { action: 'time', ms: 5 }, 'ego_wait'],
      ['ego_wait', { action: 'selector', selector: '#a', state: 'hidden' }, 'ego_wait_for_selector'],
      ['ego_wait', { action: 'url', pattern: '/done', timeout: 100 }, 'ego_wait_for_url'],
      ['ego_wait', { action: 'response', url: '/api', body: 'json' }, 'ego_wait_for_response'],
      ['ego_eval', { action: 'js', expression: 'document.title' }, 'ego_js'],
      ['ego_eval', { action: 'cdp', method: 'Page.reload', params: {} }, 'ego_cdp'],
      ['ego_eval', { action: 'script', script: 'console.log(1)', timeoutMs: 1000 }, 'ego_script'],
      ['ego_space', { action: 'open', name: 'default' }, 'ego_space_open'],
      ['ego_space', { action: 'close', name: 'default', keep: true }, 'ego_space_close'],
      ['ego_space', { action: 'flush' }, 'ego_auth_flush'],
      ['ego_doctor', { action: 'full' }, 'ego_doctor'],
      ['ego_doctor', {}, 'ego_doctor'],
      ['ego_doctor', { action: 'cli' }, 'ego_status'],
    ]
    for (const [name, args, target] of rows) {
      const facade = out.find((tool) => tool.name === name)!
      const { action: _action, ...rest } = args
      const targetExecute = inner.get(target)!.execute as ReturnType<typeof vi.fn>
      targetExecute.mockClear()
      await expect(facade.execute(args, exec)).resolves.toEqual({ ok: true, via: target, args: rest })
      expect(targetExecute).toHaveBeenCalledTimes(1)
      expect(targetExecute).toHaveBeenCalledWith(rest, exec)
      expect(targetExecute.mock.calls[0][0]).not.toHaveProperty('action')
    }
  })
})

describe('multi-route render and presentCall', () => {
  it('render goes to the routed tool with action stripped; unknown action falls back to JSON text', () => {
    const inner = new Map<string, ToolDefinition>()
    for (const [name, tool] of captured.inner!) {
      inner.set(name, { ...tool, output: { ...tool.output, render: vi.fn(() => [{ type: 'text' as const, text: name }]) } })
    }
    const out: ToolDefinition[] = []
    registerFacades(inner, (tool) => out.push(tool))
    const facade = (name: string): ToolDefinition => out.find((tool) => tool.name === name)!
    const value = { ok: true }

    expect(facade('ego_snapshot').output.render({ scope: 'full_page' }, value)).toEqual([{ type: 'text', text: 'ego_snapshot' }])
    expect(inner.get('ego_snapshot')!.output.render).toHaveBeenCalledWith({ scope: 'full_page' }, value)
    expect(facade('ego_wait').output.render({ action: 'url', pattern: '/x' }, value)).toEqual([{ type: 'text', text: 'ego_wait_for_url' }])
    expect(inner.get('ego_wait_for_url')!.output.render).toHaveBeenCalledWith({ pattern: '/x' }, value)
    expect(facade('ego_wait').output.render({ action: 'idle' }, value)).toEqual([{ type: 'text', text: JSON.stringify(value) }])
    expect(facade('ego_wait').output.render({}, value)).toEqual([{ type: 'text', text: JSON.stringify(value) }])
    expect(facade('ego_wait').output.render(null, value)).toEqual([{ type: 'text', text: JSON.stringify(value) }])
  })

  it('presentCall titles use the action or defaultAction, else the bare name', () => {
    expect(byName('ego_snapshot').presentCall?.({})).toMatchObject({ title: 'ego_snapshot · page' })
    expect(byName('ego_snapshot').presentCall?.(null)).toMatchObject({ title: 'ego_snapshot · page' })
    expect(byName('ego_doctor').presentCall?.({ action: 'cli' })).toMatchObject({ title: 'ego_doctor · cli' })
    expect(byName('ego_wait').presentCall?.({})).toMatchObject({ title: 'ego_wait', card: 'generic', kind: 'other' })
    expect(byName('ego_wait').presentCall?.({ action: 5 })).toMatchObject({ title: 'ego_wait' })
  })

  it('dispatch with null args uses defaultAction', async () => {
    const inner = new Map<string, ToolDefinition>()
    for (const [name, tool] of captured.inner!) {
      inner.set(name, { ...tool, execute: vi.fn(async (args: unknown) => ({ ok: true, via: name, args })) })
    }
    const out: ToolDefinition[] = []
    registerFacades(inner, (tool) => out.push(tool))
    await expect(out.find((tool) => tool.name === 'ego_doctor')!.execute(null as never, exec))
      .resolves.toEqual({ ok: true, via: 'ego_doctor', args: {} })
    const err = await out.find((tool) => tool.name === 'ego_wait')!.execute({ action: 5 }, exec).catch((e: unknown) => e)
    expect((err as Error).message).toBe('ego_wait: unknown action 5. Use one of: time, selector, url, response.')
  })
})

describe('coverage check', () => {
  it('D5: a collected tool missing from FACADES and EXCLUDED fails registration with its name', () => {
    const inner = new Map(captured.inner!)
    inner.set('ego_fake', { ...captured.inner!.get('ego_wait')!, name: 'ego_fake' })
    expect(() => registerFacades(inner, () => {})).toThrow(/ego_fake/)
  })
})

describe('descriptions', () => {
  it('S7: every ego_ name in tool and parameter descriptions is one of the 19 tools', () => {
    const allowed = new Set(S1)
    for (const tool of registered) {
      const texts = [tool.description]
      const properties = (tool.parameters as { properties?: Record<string, { description?: string }> }).properties ?? {}
      for (const schema of Object.values(properties)) if (schema.description !== undefined) texts.push(schema.description)
      for (const text of texts) {
        for (const [ref] of text.matchAll(/ego_[a-z_]+/g)) {
          expect(allowed.has(ref), `${tool.name} references ${ref}`).toBe(true)
        }
      }
    }
  })

  it('ego_snapshot and ego_space descriptions carry the required guidance', () => {
    const snapshot = byName('ego_snapshot').description
    expect(snapshot).toContain('[ref=N, loc=...]')
    expect(snapshot).toContain('humanCheck')
    expect(byName('ego_space').description).toContain('DO NOT call this tool when finishing tasks')
  })

  it('schema size of the 19 tools stays below the v0.8.6 baseline of 20,858 bytes', () => {
    const bytes = (tools: ToolDefinition[]): number => tools.reduce(
      (sum, { name, description, parameters }) =>
        sum + Buffer.byteLength(JSON.stringify({ name, description, parameters }), 'utf8'),
      0,
    )
    console.log(`ego schema bytes: 19 tools = ${bytes(registered)}, 33 originals = ${bytes([...captured.inner!.values()])}`)
    expect(bytes(registered)).toBeLessThan(20_858)
  })
})

describe('buildFacade', () => {
  it('throws when a parameter has different types across routes of one facade', () => {
    const inner = new Map(captured.inner!)
    const url = inner.get('ego_wait_for_url')!
    const parameters = url.parameters as { properties: Record<string, Record<string, unknown>> }
    inner.set('ego_wait_for_url', {
      ...url,
      parameters: { ...parameters, properties: { ...parameters.properties, timeout: { type: 'string' } } },
    })
    expect(() => registerFacades(inner, () => {})).toThrow(/ego_wait.*"timeout"/)
  })
})

describe('activity tracking', () => {
  it('D4: ego_space open counts as one ego tool call', async () => {
    markEgoToolCall.mockClear()
    spawn.mockImplementation(() => { throw new Error('test: no subprocess') })
    try {
      await byName('ego_space').execute({ action: 'open', name: 'default' }, exec).catch(() => undefined)
    } finally {
      spawn.mockReset()
    }
    expect(markEgoToolCall).toHaveBeenCalledTimes(1)
  })
})
