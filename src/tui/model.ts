import type { Plugin } from "@opencode/plugin/tui"

type Context = Plugin.Context

/** Persist the composer selection before voice can enqueue a prompt without a model. */
export async function syncCallModel(context: Pick<Context, "ui" | "client">, sessionID: string) {
  const selected = context.ui.model.current()
  if (!selected) throw new Error("Choose a model before starting a voice call.")
  await context.client.session.switchModel({
    sessionID,
    model: {
      providerID: selected.providerID,
      id: selected.modelID,
      ...(selected.variant ? { variant: selected.variant } : {}),
    },
  })
}
