import { existsSync, readFileSync } from "fs"
import { join } from "path"

export type TaskDefinition = {
  name: string
  desc: string
  internal: boolean
  deps: string[]
  hasNonTaskCommands: boolean
  namespace?: string
}

export type ParsedTaskfile = {
  version: string | null
  includes: Record<string, string | null>
  tasks: Record<string, TaskDefinition>
}

export function parseTaskfileYaml(content: string): ParsedTaskfile {
  const result: ParsedTaskfile = {
    version: null,
    includes: {},
    tasks: {},
  }

  const lines = content.split("\n")
  let currentSection: "includes" | "tasks" | null = null
  let currentKey: string | null = null
  let currentTask: string | null = null
  let baseIndent = 0

  for (const line of lines) {
    const trimmed = line.trim()

    if (!trimmed || trimmed.startsWith("#")) continue

    const indent = line.search(/\S/)

    if (indent === 0) {
      const colonIdx = trimmed.indexOf(":")
      if (colonIdx > 0) {
        const key = trimmed.substring(0, colonIdx)
        const value = trimmed.substring(colonIdx + 1).trim()

        if (key === "version") {
          result.version = value.replace(/[\'\"]/g, "")
          currentSection = null
        } else if (key === "includes") {
          currentSection = "includes"
          currentKey = null
        } else if (key === "tasks") {
          currentSection = "tasks"
          currentTask = null
        } else {
          currentSection = null
        }
      }
      continue
    }

    if (currentSection === "includes") {
      if (indent === 2 && trimmed.endsWith(":") && !trimmed.includes(" ")) {
        currentKey = trimmed.slice(0, -1)
        result.includes[currentKey] = null
        continue
      }

      if (indent === 2 && trimmed.includes(":") && !trimmed.endsWith(":")) {
        const match = trimmed.match(/^(\w+):\s*(.+)$/)
        if (match) {
          if (!["taskfile", "vars", "dir"].includes(match[1])) {
            result.includes[match[1]] = match[2].trim()
            currentKey = null
          }
        }
        continue
      }

      if (indent === 4 && currentKey && trimmed.startsWith("taskfile:")) {
        const value = trimmed.replace("taskfile:", "").trim()
        result.includes[currentKey] = value
        continue
      }
    }

    if (currentSection === "tasks") {
      if (indent === 2) {
        const match = trimmed.match(/^[\'"]?([^\'"]+)[\'"]?:\s*$/)
        if (match) {
          currentTask = match[1]
          result.tasks[currentTask] = {
            name: currentTask,
            desc: "",
            internal: currentTask.startsWith("_"),
            deps: [],
            hasNonTaskCommands: false,
          }
          baseIndent = indent
          continue
        }
      }

      if (currentTask && indent > baseIndent) {
        if (trimmed.startsWith("desc:")) {
          result.tasks[currentTask].desc = trimmed.replace("desc:", "").trim().replace(/^[\'"]|[\'"]$/g, "")
        }
        if (trimmed.startsWith("internal:")) {
          result.tasks[currentTask].internal = trimmed.includes("true")
        }
        if (trimmed.startsWith("- task:")) {
          const dep = trimmed.replace("- task:", "").trim()
          result.tasks[currentTask].deps.push(dep)
        } else if (trimmed.startsWith("- ")) {
          result.tasks[currentTask].hasNonTaskCommands = true
        }
      }
    }
  }

  return result
}

export function loadTaskfile(worktree: string): ParsedTaskfile | null {
  const taskfilePath = join(worktree, "Taskfile.yml")
  if (!existsSync(taskfilePath)) {
    return null
  }

  const content = readFileSync(taskfilePath, "utf8")
  const parsed = parseTaskfileYaml(content)

  for (const [namespace, relativePath] of Object.entries(parsed.includes)) {
    if (!relativePath) continue

    const includePath = join(worktree, relativePath)
    if (!existsSync(includePath)) continue

    try {
      const includeContent = readFileSync(includePath, "utf8")
      const includeParsed = parseTaskfileYaml(includeContent)

      for (const [taskName, taskData] of Object.entries(includeParsed.tasks)) {
        const fullName = `${namespace}:${taskName}`
        parsed.tasks[fullName] = {
          ...taskData,
          name: fullName,
          namespace,
        }
      }
    } catch {
      // Skip unreadable includes
    }
  }

  return parsed
}
