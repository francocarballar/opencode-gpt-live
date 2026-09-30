import { afterEach, describe, expect, jest, mock, spyOn, test } from "bun:test"

import { VoiceController } from "../src/tui/controller"
import * as helpers from "../src/tui/helper"
import { createTuiPlugin } from "../src/tui/index"
import type { Core } from "../src/tui/ui"

type Context = ConstructorParameters<typeof VoiceController>[0]
type Selection = NonNullable<ReturnType<Context["ui"]["model"]["current"]>>

const cleanups: Array<() => void | Promise<void>> = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
  mock.restore()
  jest.useRealTimers()
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function fixture(home = false) {
  jest.useFakeTimers()
  const selected = { providerID: "openai", modelID: "reasoner", variant: "high" }
  const model = { providerID: "openai", id: "reasoner", variant: "high" }
  const selection = jest.fn((): Selection | undefined => selected)
  const location = { directory: "/project" }
  const call = { callID: "call", voiceSessionID: "voice", previous: [], sdp: "answer", voice: "cove", model: "live" }
  const rpc = {
    events: { on: () => () => {} },
    start: jest.fn(async () => call),
    stop: jest.fn(async () => ({ stopped: true })),
    alive: jest.fn(async () => ({ active: true })),
  }
  const session = {
    create: jest.fn(async () => ({ id: "created" })),
    switchModel: jest.fn(async () => {}),
  }
  const ensure = spyOn(helpers, "ensureHelper").mockResolvedValue("fake")
  const helper = {
    start: jest.fn(async () => "offer"),
    answer: jest.fn(async () => {}),
    close: jest.fn(async () => {}),
    kill: jest.fn(() => {}),
  }
  const callbacks: helpers.HelperCallbacks[] = []
  const constructors = helpers as unknown as {
    HelperProcess: (binary: string, hooks?: helpers.HelperCallbacks) => helpers.HelperProcess
  }
  const spawn = spyOn(constructors, "HelperProcess").mockImplementation(function (_binary, hooks) {
    callbacks.push(hooks ?? {})
    return helper as unknown as helpers.HelperProcess
  })
  let route: { type: "home" } | { type: "session"; sessionID: string } = home
    ? { type: "home" }
    : { type: "session", sessionID: "main" }
  const renderer = { currentFocusedEditor: { isDestroyed: false } }
  const commands: Array<{ id: string; run: () => Promise<void> }> = []
  const navigate = jest.fn((next: typeof route) => {
    route = next
    renderer.currentFocusedEditor = { isDestroyed: false }
  })
  const panel = { current: () => undefined, close: jest.fn(), open: jest.fn(() => true) }
  const toast = jest.fn()
  const context = {
    options: { panel: false },
    data: { session: { get: () => ({ location }) }, location: { default: () => location } },
    renderer,
    keymap: {
      shortcuts: () => [],
      layer: (read: () => { commands: typeof commands }) => commands.push(...read().commands),
    },
    ui: {
      model: { current: selection },
      router: { current: () => route, navigate },
      panel,
      toast: { show: toast },
      slot: (slot: { append?: string; render: () => void }) => {
        if (slot.append === "app") slot.render()
        return () => {}
      },
    },
    client: { session, rpc: () => rpc },
  } as unknown as Context
  const controller = new VoiceController(context, {})
  cleanups.push(() => controller.dispose())
  return {
    context,
    controller,
    model,
    selected,
    selection,
    location,
    rpc,
    session,
    ensure,
    helper,
    callbacks,
    spawn,
    navigate,
    panel,
    toast,
    commands,
    route: (next: typeof route) => {
      route = next
    },
  }
}

async function plugin(f: ReturnType<typeof fixture>) {
  const cleanup = await createTuiPlugin({} as Core).setup(f.context)
  if (typeof cleanup === "function") cleanups.push(cleanup)
  return (id: string) => {
    const command = f.commands.find((item) => item.id === id)
    if (!command) throw new Error(`Missing command: ${id}`)
    return command.run()
  }
}

describe("voice model during Home startup", () => {
  test("uses one copied selection for creation and persistence across navigation", async () => {
    const f = fixture(true)
    const command = await plugin(f)
    const created = deferred<{ id: string }>()
    f.session.create.mockImplementation(() => created.promise)
    const starting = command("gptlive.toggle")
    f.selected.providerID = "other"
    f.selected.modelID = "other-model"
    f.selected.variant = "low"
    created.resolve({ id: "created" })
    await created.promise
    jest.advanceTimersByTime(25)
    await starting
    expect(f.selection).toHaveBeenCalledTimes(1)
    expect(f.session.create).toHaveBeenCalledWith({ location: f.location, model: f.model })
    expect(f.session.switchModel).toHaveBeenCalledWith({ sessionID: "created", model: f.model })
    expect(f.rpc.start).toHaveBeenCalledWith(
      { sessionID: "created", sdp: "offer", voice: undefined, fresh: false },
      { location: f.location },
    )
  })

  test("does not start or persist another session's model after leaving the created session", async () => {
    const f = fixture(true)
    const command = await plugin(f)
    f.navigate.mockImplementation(() => {
      f.route({ type: "session", sessionID: "other" })
      f.selection.mockReturnValue({ providerID: "other", modelID: "other-model" })
    })
    const starting = command("gptlive.toggle")
    await Promise.resolve()
    jest.advanceTimersByTime(2_000)
    await starting
    expect(f.selection).toHaveBeenCalledTimes(1)
    expect(f.session.switchModel).not.toHaveBeenCalled()
    expect(f.ensure).not.toHaveBeenCalled()
    expect(f.rpc.start).not.toHaveBeenCalled()
    expect(f.panel.open).not.toHaveBeenCalled()
  })
})
