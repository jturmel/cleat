import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

export function isDirectExecution(importMetaUrl: string, argv1: string | undefined) {
  if (!argv1) return false

  try {
    return fileURLToPath(importMetaUrl) === resolve(argv1)
  } catch {
    return false
  }
}
