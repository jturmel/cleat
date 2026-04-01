# Taskfile YAML Canonicalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Cleat read existing Taskfile `.yml` or `.yaml` setups, while always emitting canonical `.yaml` migration guidance with root `Taskfile.yaml` importing `taskfiles/_root.yaml` and emphasizing silenced inline shell plus script extraction.

**Architecture:** Introduce a shared Taskfile path resolver in `tasks.ts` and route plugin checks through it to remove hardcoded root filename assumptions. Preserve non-fatal include handling while adding extension fallback for includes. Update migration prompt/plan wording to the canonical structure and expand tests to lock in compatibility and output expectations.

**Tech Stack:** Node.js, TypeScript, existing plugin runtime (`.opencode/plugins/cleat-plugin.js`), built artifacts (`tasks.js`), unit tests (`node tests/cleat-plugin.test.js`).

---

### Task 1: Add canonical/legacy Taskfile path resolution

**Files:**
- Modify: `tasks.ts`
- Build output: `tasks.js`
- Test: `tests/cleat-plugin.test.js`

- [ ] **Step 1: Write failing tests for root and include resolution**

```js
function testLoadTaskfilePrefersYamlRoot() {
  const tempRoot = mkdtempSync(join(tmpdir(), "cleat-taskfile-prefer-yaml-"));
  try {
    writeFileSync(join(tempRoot, "Taskfile.yaml"), 'version: "3"\n', "utf8");
    writeFileSync(join(tempRoot, "Taskfile.yml"), 'version: "2"\n', "utf8");
    const parsed = loadTaskfile(tempRoot);
    assert.equal(parsed?.version, "3");
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}
```

- [ ] **Step 2: Run test to verify failure**

Run: `npm run test:unit -- --grep "prefers yaml root"`
Expected: FAIL because current loader only reads `Taskfile.yml`.

- [ ] **Step 3: Implement resolver in `tasks.ts`**

```ts
export function resolveRootTaskfilePath(worktree: string): string | null {
  const yamlPath = join(worktree, "Taskfile.yaml")
  if (existsSync(yamlPath)) return yamlPath
  const ymlPath = join(worktree, "Taskfile.yml")
  if (existsSync(ymlPath)) return ymlPath
  return null
}
```

- [ ] **Step 4: Implement include fallback and use resolver in `loadTaskfile`**

```ts
function resolveIncludePath(worktree: string, relativePath: string): string | null {
  const direct = join(worktree, relativePath)
  if (existsSync(direct)) return direct
  if (relativePath.endsWith(".yaml")) {
    const alt = join(worktree, relativePath.slice(0, -5) + ".yml")
    if (existsSync(alt)) return alt
  }
  if (relativePath.endsWith(".yml")) {
    const alt = join(worktree, relativePath.slice(0, -4) + ".yaml")
    if (existsSync(alt)) return alt
  }
  return null
}
```

- [ ] **Step 5: Run full unit tests and build output**

Run: `npm run test:unit`
Expected: PASS, with `tasks.js` regenerated from `tasks.ts` via `npm run build`.


### Task 2: Route plugin Taskfile checks through resolver

**Files:**
- Modify: `.opencode/plugins/cleat-plugin.js`
- Modify: `tests/cleat-plugin.test.js`

- [ ] **Step 1: Write failing plugin-level test for `.yaml` detection**

```js
function testDetectAutomationContextWithYamlRoot() {
  const tempRoot = mkdtempSync(join(tmpdir(), "cleat-context-yaml-"));
  try {
    writeFileSync(join(tempRoot, "Taskfile.yaml"), 'version: "3"\n', "utf8");
    const context = __cleatInternals.detectAutomationContext(tempRoot);
    assert.equal(context.hasTaskfile, true);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm run test:unit`
Expected: FAIL because plugin currently checks only `Taskfile.yml`.

- [ ] **Step 3: Update plugin imports and checks**

```js
import { loadTaskfile, parseTaskfileYaml, resolveRootTaskfilePath } from "../../tasks.js";

const hasTaskfile = !!resolveRootTaskfilePath(worktree);
if (!resolveRootTaskfilePath(worktree)) {
  return `No Taskfile.yaml/Taskfile.yml found in ${worktree}.`;
}
```

- [ ] **Step 4: Run tests**

Run: `npm run test:unit`
Expected: PASS for detection and all task tool guard checks.


### Task 3: Canonicalize migration guidance output

**Files:**
- Modify: `.opencode/plugins/cleat-plugin.js`
- Modify: `README.md`
- Modify: `package.json`
- Test: `tests/cleat-plugin.test.js`

- [ ] **Step 1: Add/adjust tests for canonical guidance strings**

```js
assert.equal(prompt.includes("Taskfile.yaml"), true);
assert.equal(prompt.includes("taskfiles/_root.yaml"), true);
assert.equal(prompt.includes("flatten: true"), true);
assert.equal(prompt.includes("taskfiles/scripts/"), true);
assert.equal(prompt.includes("silent: true"), true);
```

- [ ] **Step 2: Update migration plan and prompt text**

```js
const steps = [
  "Create/adjust Taskfile.yaml with flatten: true and root import of taskfiles/_root.yaml.",
  "Create/update taskfiles/_root.yaml for root/front-door tasks and namespace imports.",
  "Create/update namespace taskfiles under taskfiles/*.yaml.",
  "Move shell-heavy task logic into taskfiles/scripts/ and keep inline cmds silent (silent: true).",
];
```

- [ ] **Step 3: Update public docs text to canonical naming + compatibility note**

```md
Cleat is a task-aware AI CLI plugin focused on helping agents discover, explain,
recommend, and run project workflows defined in `Taskfile.yaml` (with support
for existing `Taskfile.yml` projects).
```

- [ ] **Step 4: Run tests**

Run: `npm run test:unit`
Expected: PASS with updated prompt/text assertions.


### Task 4: Verification and cleanup

**Files:**
- Verify only: working tree

- [ ] **Step 1: Run targeted build and tests**

Run: `npm run build && npm run test:unit`
Expected: both commands pass.

- [ ] **Step 2: Verify no `.yml` hardcoding remains for root Taskfile checks**

Run: `rg "Taskfile\.yml" .opencode/plugins/cleat-plugin.js tasks.ts tests/cleat-plugin.test.js README.md package.json`
Expected: only compatibility mentions remain, no hardcoded `.yml`-only logic.

- [ ] **Step 3: Commit**

```bash
git add .context/plan-specs/2026-04-01-taskfile-yaml-canonicalization-design.md \
  .context/plans/2026-04-01-taskfile-yaml-canonicalization.md \
  tasks.ts tasks.js .opencode/plugins/cleat-plugin.js \
  tests/cleat-plugin.test.js README.md package.json
git commit -m "feat: canonicalize Taskfile yaml migration guidance with legacy yml compatibility"
```
