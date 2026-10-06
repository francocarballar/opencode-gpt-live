import { describe, expect, test } from "bun:test"

import { callModel, syncCallModel } from "../src/tui/model"

type Context = Parameters<typeof syncCallModel>[0] & Parameters<typeof callModel>[0]

function fixture(selected?: { providerID: string; modelID: string; variant?: string }, fail = false) {
  const calls: unknown[] = []
  const context = {
    ui: { model: { current: () => selected } },
    client: {
      session: {
        switchModel: async (input: unknown) => {
          calls.push(input)
          if (fail) throw new Error("session unavailable")
        },
      },
    },
  } as unknown as Context
  return { context, calls }
}

describe("voice coding-session model", () => {
  test("persists a new session's composer selection without sending a written prompt", async () => {
    const { context, calls } = fixture({ providerID: "opencode", modelID: "free-model" })
    await syncCallModel(context, "new-session", callModel(context))
    expect(calls).toEqual([{ sessionID: "new-session", model: { providerID: "opencode", id: "free-model" } }])
  })
  test("preserves the selected variant and targets only the coding session", async () => {
    const { context, calls } = fixture({ providerID: "openai", modelID: "reasoner", variant: "high" })
    await syncCallModel(context, "coding-session", callModel(context))
    expect(calls).toEqual([
      { sessionID: "coding-session", model: { providerID: "openai", id: "reasoner", variant: "high" } },
    ])
  })
  test("returns no model when the composer has no selection", async () => {
    const { context, calls } = fixture()
    expect(callModel(context)).toBeUndefined()
    await syncCallModel(context, "coding-session", undefined)
    expect(calls).toEqual([])
  })
  test("awaits persistence and propagates failures before a call can start", async () => {
    const { context } = fixture({ providerID: "opencode", modelID: "free-model" }, true)
    await expect(syncCallModel(context, "new-session", callModel(context))).rejects.toThrow("session unavailable")
  })
  test("copies the selection instead of retaining a live UI object", async () => {
    const selected = { providerID: "openai", modelID: "reasoner", variant: "high" }
    const { context, calls } = fixture(selected)
    const model = callModel(context)
    selected.providerID = "other"
    selected.modelID = "other-model"
    selected.variant = "low"
    await syncCallModel(context, "coding-session", model)
    expect(calls).toEqual([
      { sessionID: "coding-session", model: { providerID: "openai", id: "reasoner", variant: "high" } },
    ])
  })
})
