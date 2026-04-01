import { existsSync, readFileSync } from "fs"
import { join } from "path"

const ROOT_TASKFILE_CANDIDATES = ["Taskfile.yaml", "Taskfile.yml"]

function swapTaskfileExtension(path: string): string | null {
  if (path.endsWith(".yaml")) return `${path.slice(0, -5)}.yml`
  if (path.endsWith(".yml")) return `${path.slice(0, -4)}.yaml`
  return null
}

export function resolveRootTaskfilePath(worktree: string): string | null {
  for (const candidate of ROOT_TASKFILE_CANDIDATES) {
    const candidatePath = join(worktree, candidate)
    if (existsSync(candidatePath)) return candidatePath
  }
  return null
}

export function resolveTaskfileIncludePath(worktree: string, relativePath: string): string | null {
  const directPath = join(worktree, relativePath)
  if (existsSync(directPath)) return directPath

  const alternate = swapTaskfileExtension(relativePath)
  if (!alternate) return null

  const alternatePath = join(worktree, alternate)
  if (existsSync(alternatePath)) return alternatePath

  return null
}

export type TaskDefinition = {
  name: string
  desc: string
  summary: string
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
  let multilineField: "desc" | "summary" | null = null
  let multilineIndent = 0

  const finishMultilineField = () => {
    multilineField = null
    multilineIndent = 0
  }

  for (const line of lines) {
    const trimmed = line.trim()
    const indent = line.search(/\S/)

    if (multilineField && currentTask) {
      if (!trimmed) {
        result.tasks[currentTask][multilineField] += "\n"
        continue
      }

      if (indent > multilineIndent) {
        const value = line.slice(Math.min(line.length, multilineIndent + 2))
        result.tasks[currentTask][multilineField] += `${value}\n`
        continue
      }

      result.tasks[currentTask][multilineField] = result.tasks[currentTask][multilineField].trimEnd()
      finishMultilineField()
    }

    if (!trimmed || trimmed.startsWith("#")) continue

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
            summary: "",
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
          const value = trimmed.replace("desc:", "").trim()
          if (value === "|" || value === ">") {
            result.tasks[currentTask].desc = ""
            multilineField = "desc"
            multilineIndent = indent
          } else {
            result.tasks[currentTask].desc = value.replace(/^[\'"]|[\'"]$/g, "")
          }
        }
        if (trimmed.startsWith("summary:")) {
          const value = trimmed.replace("summary:", "").trim()
          if (value === "|" || value === ">") {
            result.tasks[currentTask].summary = ""
            multilineField = "summary"
            multilineIndent = indent
          } else {
            result.tasks[currentTask].summary = value.replace(/^[\'"]|[\'"]$/g, "")
          }
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

  if (multilineField && currentTask) {
    result.tasks[currentTask][multilineField] = result.tasks[currentTask][multilineField].trimEnd()
  }

  return result
}

export function loadTaskfile(worktree: string): ParsedTaskfile | null {
  const taskfilePath = resolveRootTaskfilePath(worktree)
  if (!taskfilePath) {
    return null
  }

  const content = readFileSync(taskfilePath, "utf8")
  const parsed = parseTaskfileYaml(content)

  for (const [namespace, relativePath] of Object.entries(parsed.includes)) {
    if (!relativePath) continue

    const includePath = resolveTaskfileIncludePath(worktree, relativePath)
    if (!includePath) continue

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
