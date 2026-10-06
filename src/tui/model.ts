import type { Plugin } from "@opencode/plugin/tui"

type Context = Plugin.Context
export type CallModel = Parameters<Context["client"]["session"]["switchModel"]>[0]["model"]

/** Copy the selection before navigating or waiting for a session to be created. */
export function callModel(context: Pick<Context, "ui">): CallModel | undefined {
  const selected = context.ui.model.current()
  if (!selected) return undefined
  return {
    providerID: selected.providerID,
    id: selected.modelID,
    ...(selected.variant ? { variant: selected.variant } : {}),
  }
}

/** Persist the captured selection before voice can enqueue a prompt without a model. */
export async function syncCallModel(context: Pick<Context, "client">, sessionID: string, model: CallModel | undefined) {
  if (!model) return
  await context.client.session.switchModel({
    sessionID,
    model,
  })
}
