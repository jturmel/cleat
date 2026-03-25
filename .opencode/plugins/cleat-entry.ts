import { CleatPlugin as CoreCleatPlugin } from "./cleat-plugin.ts"
import type { PluginInput } from "@opencode-ai/plugin"

export const CleatPlugin = async (input: PluginInput) => {
  return CoreCleatPlugin(input)
}
