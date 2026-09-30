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
    return { ...helper } as unknown as helpers.HelperProcess
  })
  let route: { type: "home" } | { type: "session"; sessionID: string } = home
    ? { type: "home" }
    : { type: "session", sessionID: "main" }
  const renderer = { currentFocusedEditor: { isDestroyed: false }, focusRenderable: jest.fn() }
  const commands: Array<{ id: string; run: () => Promise<void> }> = []
  const navigate = jest.fn((next: typeof route) => {
    route = next
    renderer.currentFocusedEditor = { isDestroyed: false }
  })
  const panel = { current: () => undefined, close: jest.fn(), open: jest.fn(() => true) }
  const toast = jest.fn()
  const context = {
    options: { panel: home },
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
    call,
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
  if (typeof cleanup !== "function") throw new Error("Missing plugin cleanup")
  cleanups.push(cleanup)
  const run = (id: string) => {
    const command = f.commands.find((item) => item.id === id)
    if (!command) throw new Error(`Missing command: ${id}`)
    return command.run()
  }
  return { run, dispose: cleanup }
}

describe("voice model during Home startup", () => {
  test("uses one copied selection for creation and persistence across navigation", async () => {
    const f = fixture(true)
    const { run: command } = await plugin(f)
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
    expect(f.panel.open).toHaveBeenCalledTimes(1)
    expect(f.rpc.start).toHaveBeenCalledWith(
      { sessionID: "created", sdp: "offer", voice: undefined, fresh: false },
      { location: f.location },
    )
  })

  test("does not start or persist another session's model after leaving the created session", async () => {
    const f = fixture(true)
    const { run: command } = await plugin(f)
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

  test("reports a missing selection without creating a session or helper", async () => {
    const f = fixture(true)
    const { run: command } = await plugin(f)
    f.selection.mockReturnValue(undefined)
    await command("gptlive.toggle")
    expect(f.toast).toHaveBeenCalledWith({
      title: "GPT-Live",
      message: "Choose a model before starting a voice call.",
      variant: "error",
    })
    expect(f.session.create).not.toHaveBeenCalled()
    expect(f.ensure).not.toHaveBeenCalled()
  })
})

describe("voice startup cancellation", () => {
  test.each(["model", "binary", "offer", "call", "answer"] as const)(
    "stop invalidates an attempt waiting for %s",
    async (stage) => {
      const f = fixture()
      const reached = deferred<void>()
      const resume = deferred<void>()
      const wait = async () => {
        reached.resolve()
        await resume.promise
      }
      if (stage === "model") f.session.switchModel.mockImplementation(wait)
      if (stage === "binary")
        f.ensure.mockImplementation(async () => {
          await wait()
          return "fake"
        })
      if (stage === "offer")
        f.helper.start.mockImplementation(async () => {
          await wait()
          return "offer"
        })
      if (stage === "call")
        f.rpc.start.mockImplementation(async () => {
          await wait()
          return f.call
        })
      if (stage === "answer") f.helper.answer.mockImplementation(wait)
      const starting = f.controller.start("main", f.model)
      await reached.promise
      await f.controller.stop()
      const revision = f.controller.state.revision
      const notices = f.toast.mock.calls.length
      if (stage === "binary") f.ensure.mock.calls[0][0]?.("late download progress")
      resume.resolve()
      await starting
      expect(f.controller.state.phase).toBe("idle")
      expect(f.controller.state.revision).toBe(revision)
      expect(f.toast).toHaveBeenCalledTimes(notices)
      if (stage === "model" || stage === "binary") expect(f.spawn).not.toHaveBeenCalled()
      if (stage === "model" || stage === "binary" || stage === "offer") expect(f.rpc.start).not.toHaveBeenCalled()
      if (stage !== "answer") expect(f.helper.answer).not.toHaveBeenCalled()
      if (stage === "offer" || stage === "call" || stage === "answer") expect(f.helper.close).toHaveBeenCalledTimes(1)
      if (stage === "call" || stage === "answer")
        expect(f.rpc.stop).toHaveBeenCalledWith({ callID: f.call.callID }, { location: f.location })
      jest.advanceTimersByTime(5_000)
      expect(f.rpc.alive).not.toHaveBeenCalled()
      await f.controller.start("main", f.model)
      expect(f.controller.state.phase).toBe("live")
    },
  )

  test("dispose prevents a pending model sync and all subsequent starts from creating resources", async () => {
    const f = fixture()
    const pending = deferred<void>()
    f.session.switchModel.mockImplementation(() => pending.promise)
    const starting = f.controller.start("main", f.model)
    await f.controller.dispose()
    pending.resolve()
    await starting
    await f.controller.start("main", f.model)
    expect(f.session.switchModel).toHaveBeenCalledTimes(1)
    expect(f.ensure).not.toHaveBeenCalled()
    expect(f.spawn).not.toHaveBeenCalled()
    expect(f.rpc.start).not.toHaveBeenCalled()
    expect(f.controller.state.phase).toBe("idle")
  })

  test("ignores a cancelled attempt's late rejection", async () => {
    const f = fixture()
    const pending = deferred<void>()
    f.session.switchModel.mockImplementation(() => pending.promise)
    const starting = f.controller.start("main", f.model)
    await f.controller.stop()
    const notices = f.toast.mock.calls.length
    pending.reject(new Error("late failure"))
    await starting
    expect(f.controller.state.error).toBeUndefined()
    expect(f.toast).toHaveBeenCalledTimes(notices)
    expect(f.ensure).not.toHaveBeenCalled()
  })

  test("a persistence failure is visible and cannot start the helper", async () => {
    const f = fixture()
    f.session.switchModel.mockRejectedValue(new Error("session unavailable"))
    await f.controller.start("main", f.model)
    expect(f.controller.state.phase).toBe("error")
    expect(f.controller.state.error).toBe("session unavailable")
    expect(f.ensure).not.toHaveBeenCalled()
    expect(f.rpc.start).not.toHaveBeenCalled()
    expect(f.toast).toHaveBeenCalledWith(expect.objectContaining({ message: "session unavailable", variant: "error" }))
  })

  test("callbacks from an old helper cannot affect the next call", async () => {
    const f = fixture()
    await f.controller.start("main", f.model)
    const old = f.callbacks[0]
    await f.controller.stop()
    await f.controller.start("main", f.model)
    const revision = f.controller.state.revision
    old.onEvent?.({ type: "warning", message: "late warning" })
    old.onEvent?.({ type: "audio", input: { name: "old microphone" } })
    old.onEvent?.({ type: "error", fatal: true, message: "late failure" })
    old.onExit?.(1, "late exit")
    expect(f.controller.state.phase).toBe("live")
    expect(f.controller.state.revision).toBe(revision)
    expect(f.helper.close).toHaveBeenCalledTimes(1)
  })
})

describe("Home preparation cancellation", () => {
  test.each(["stop", "dispose"] as const)("%s during creation prevents late navigation and startup", async (action) => {
    const f = fixture(true)
    const { run: command, dispose } = await plugin(f)
    const created = deferred<{ id: string }>()
    f.session.create.mockImplementation(() => created.promise)
    const starting = command("gptlive.toggle")
    if (action === "stop") await command("gptlive.stop")
    else await dispose()
    created.resolve({ id: "created" })
    await starting
    expect(f.navigate).not.toHaveBeenCalled()
    expect(f.panel.open).not.toHaveBeenCalled()
    expect(f.session.switchModel).not.toHaveBeenCalled()
    expect(f.ensure).not.toHaveBeenCalled()
    if (action === "dispose") {
      await command("gptlive.toggle")
      expect(f.session.create).toHaveBeenCalledTimes(1)
    }
  })

  test("stop while waiting for focus prevents model persistence and helper startup", async () => {
    const f = fixture(true)
    const { run: command } = await plugin(f)
    const starting = command("gptlive.toggle")
    await Promise.resolve()
    expect(f.navigate).toHaveBeenCalled()
    await command("gptlive.stop")
    jest.advanceTimersByTime(25)
    await starting
    expect(f.session.switchModel).not.toHaveBeenCalled()
    expect(f.spawn).not.toHaveBeenCalled()
    expect(f.rpc.start).not.toHaveBeenCalled()
  })
})
