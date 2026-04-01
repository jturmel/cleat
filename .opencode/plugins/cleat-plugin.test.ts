import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { join, dirname } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"

import { CleatPlugin, __cleatInternals } from "./cleat-plugin.js"
import { loadTaskfile, parseTaskfileYaml } from "../../tasks.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixtures = join(__dirname, "..", "..", "fixtures")

function readFixture(name) {
  return readFileSync(join(fixtures, name), "utf8")
}

function testParseSlashCommand() {
  assert.equal(__cleatInternals.parseSlashCommand("/cleat-migrate-makefile"), "cleat-migrate-makefile")
  assert.equal(__cleatInternals.parseSlashCommand("cleat-scan-makefile"), "cleat-scan-makefile")
  assert.equal(__cleatInternals.parseSlashCommand("/not-a-cleat-command"), null)
}

function testSimpleMakefileClassification() {
  const parsed = __cleatInternals.parseMakefileDetails(readFixture("make-simple.mk"))
  assert.equal(parsed.targets.length >= 3, true)

  const classifications = parsed.targets.map((target) => __cleatInternals.classifyMakeTarget(target))
  const testTarget = classifications.find((item) => item.name === "test")
  assert.equal(testTarget?.risk, "safe")
}

function testNestedIncludeDetection() {
  const parsed = __cleatInternals.parseMakefileDetails(readFixture("make-nested-include.mk"))
  assert.equal(parsed.includes.length, 2)
}

function testRiskAndDestructiveClassification() {
  const parsed = __cleatInternals.parseMakefileDetails(readFixture("make-risky.mk"))
  const classifications = parsed.targets.map((target) => __cleatInternals.classifyMakeTarget(target))
  const migrate = classifications.find((item) => item.name === "migrate")
  const resetDb = classifications.find((item) => item.name === "reset-db")
  assert.equal(migrate?.risk, "risky")
  assert.equal(resetDb?.risk, "destructive")
}

function testShellHeavyTraitAndMapping() {
  const parsed = __cleatInternals.parseMakefileDetails(readFixture("make-shell-heavy.mk"))
  const classifications = parsed.targets.map((target) => __cleatInternals.classifyMakeTarget(target))
  const mapping = __cleatInternals.buildMappingFromClassifications(classifications)
  assert.equal(mapping.scriptExtractionCandidates.includes("bootstrap"), true)
  assert.equal(mapping.policyScore.scriptExtractionNeeded, "yes")
}

function testPlanArtifactFromMapping() {
  const scanArtifact = {
    stage: "scan",
    timestamp: new Date().toISOString(),
    sourceCommand: "/cleat-plan-taskfile",
    data: {
      context: {
        hasTaskfile: true,
      },
    },
  }
  const mappingArtifact = {
    stage: "map",
    timestamp: new Date().toISOString(),
    sourceCommand: "/cleat-map-make-targets",
    data: {
      mapping: {
        namespaceMap: {
          db: ["migrate"],
          verify: ["test"],
        },
      },
    },
  }
  const plan = __cleatInternals.buildPlanFromArtifacts(scanArtifact, mappingArtifact)
  assert.equal(plan.hasExistingTaskfile, true)
  assert.equal(plan.namespaces.includes("db"), true)
  assert.equal(Array.isArray(plan.candidateDiffHints), true)
}

function testOpinionatedRootSurfaceDefaults() {
  const classifications = [
    { name: "dev", role: "public", risk: "risky", traits: { prod_like: false, shell_heavy: true, depends_on_many: false } },
    { name: "dj-test", role: "public", risk: "safe", traits: { prod_like: false, shell_heavy: false, depends_on_many: false } },
    { name: "py-lint", role: "public", risk: "safe", traits: { prod_like: false, shell_heavy: false, depends_on_many: false } },
    { name: "build", role: "public", risk: "safe", traits: { prod_like: false, shell_heavy: false, depends_on_many: false } },
    { name: "gcp-deploy", role: "public", risk: "risky", traits: { prod_like: true, shell_heavy: true, depends_on_many: false } },
  ]

  const mapping = __cleatInternals.buildMappingFromClassifications(classifications)

  assert.equal(Array.isArray(mapping.recommendedRoot), true)
  assert.equal(mapping.recommendedRoot.includes("dev"), true)
  assert.equal(mapping.recommendedRoot.includes("build"), true)
  assert.equal(mapping.recommendedRoot.includes("test"), true)
  assert.equal(mapping.recommendedRoot.includes("verify"), true)
  assert.equal(mapping.recommendedRoot.includes("deploy"), true)
}

function testOpinionatedNamespaceNormalization() {
  const classifications = [
    { name: "dj-migrate-dev", role: "public", risk: "risky", traits: { prod_like: true, shell_heavy: false, depends_on_many: false } },
    { name: "load-dev-fixtures", role: "public", risk: "risky", traits: { prod_like: false, shell_heavy: false, depends_on_many: false } },
    { name: "py-lint", role: "public", risk: "safe", traits: { prod_like: false, shell_heavy: false, depends_on_many: false } },
    { name: "dj-test", role: "public", risk: "safe", traits: { prod_like: false, shell_heavy: false, depends_on_many: false } },
  ]

  const mapping = __cleatInternals.buildMappingFromClassifications(classifications)

  assert.equal(Array.isArray(mapping.renameSuggestions), true)
  assert.equal(mapping.renameSuggestions.some((item) => item.from === "dj-migrate-dev" && item.to === "db:migrate"), true)
  assert.equal(mapping.renameSuggestions.some((item) => item.from === "load-dev-fixtures" && item.to === "db:load"), true)
  assert.equal(mapping.renameSuggestions.some((item) => item.from === "py-lint" && item.to === "verify:lint"), true)
  assert.equal(mapping.renameSuggestions.some((item) => item.from === "dj-test" && item.to === "test"), true)
}

function testDeployPromotePlacement() {
  const classifications = [
    { name: "deploy", role: "public", risk: "risky", traits: { prod_like: true, shell_heavy: false, depends_on_many: false } },
    { name: "promote", role: "public", risk: "risky", traits: { prod_like: true, shell_heavy: false, depends_on_many: false } },
  ]

  const mapping = __cleatInternals.buildMappingFromClassifications(classifications)

  assert.equal(mapping.recommendedRoot.includes("deploy"), true)
  assert.equal(mapping.recommendedRoot.includes("promote"), false)
  assert.equal(mapping.renameSuggestions.some((item) => item.from === "promote" && item.to === "deploy:promote"), true)
}

function testProposedSurfaceConfidenceAndArtifact() {
  const tempRoot = mkdtempSync(join(tmpdir(), "cleat-migrate-"))

  try {
    writeFileSync(join(tempRoot, "Makefile"), `
dev:
\techo dev

dj-test:
\techo test

py-lint:
\techo lint

build:
\techo build

gcp-deploy:
\techo deploy
`, "utf8")

    const state = { artifacts: {} }
    const artifacts = __cleatInternals.buildCleatArtifactsForCommand("cleat-migrate-makefile", tempRoot, state)
    const proposed = artifacts?.proposedSurfaceArtifact?.data?.proposedSurface

    assert.notEqual(proposed, null)
    assert.equal(Array.isArray(proposed.rootEntrypoints), true)
    assert.equal(proposed.rootEntrypoints.includes("deploy"), true)
    assert.equal(typeof proposed.confidence?.score, "number")
    assert.equal(["low", "medium", "high"].includes(proposed.confidence?.level), true)
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

function testPromptQuestionPolicyUsesConfidence() {
  const lowPrompt = __cleatInternals.buildCleatPrompt(
    "cleat-migrate-makefile",
    { artifacts: {} },
    {
      proposedSurfaceArtifact: {
        stage: "proposed-surface",
        timestamp: new Date().toISOString(),
        sourceCommand: "/cleat-migrate-makefile",
        data: {
          proposedSurface: {
            ambiguities: ["custom-target"],
            confidence: { score: 0.41, level: "low", askQuestions: true },
          },
        },
      },
    },
  )

  assert.equal(lowPrompt.includes("Question policy: ask one focused question only for unresolved ambiguities"), true)
  assert.equal(lowPrompt.includes("Migration confidence: low (0.41)."), true)

  const highPrompt = __cleatInternals.buildCleatPrompt(
    "cleat-migrate-makefile",
    { artifacts: {} },
    {
      proposedSurfaceArtifact: {
        stage: "proposed-surface",
        timestamp: new Date().toISOString(),
        sourceCommand: "/cleat-migrate-makefile",
        data: {
          proposedSurface: {
            ambiguities: [],
            confidence: { score: 0.91, level: "high", askQuestions: false },
          },
        },
      },
    },
  )

  assert.equal(highPrompt.includes("Question policy: do not ask structural preference questions"), true)
  assert.equal(highPrompt.includes("Migration confidence: high (0.91)."), true)
}

function testTaskfileParsingModule() {
  const parsed = parseTaskfileYaml(`version: "3"
includes:
  api: ./taskfiles/api.yml
tasks:
  verify:
    desc: Run checks
    summary: |
      Run the full verification workflow.
      Includes API coverage.
    deps:
      - task: api:test
  _hidden:
    internal: true
    cmds:
      - echo nope
`)

  assert.equal(parsed.version, "3")
  assert.equal(parsed.includes.api, "./taskfiles/api.yml")
  assert.equal(parsed.tasks.verify.desc, "Run checks")
  assert.equal(parsed.tasks.verify.summary, "Run the full verification workflow.\nIncludes API coverage.")
  assert.deepEqual(parsed.tasks.verify.deps, ["api:test"])
  assert.equal(parsed.tasks._hidden.internal, true)
  assert.equal(parsed.tasks._hidden.hasNonTaskCommands, true)
}

function testTaskfileLoadingModule() {
  const tempRoot = mkdtempSync(join(tmpdir(), "cleat-taskfile-"))

  try {
    mkdirSync(join(tempRoot, "taskfiles"), { recursive: true })
    writeFileSync(join(tempRoot, "Taskfile.yml"), `version: "3"
includes:
  api:
    taskfile: ./taskfiles/api.yml
tasks:
  verify:
    desc: Verify everything
    summary: Verify the main project workflows
    deps:
      - task: api:test
`, "utf8")
    writeFileSync(join(tempRoot, "taskfiles", "api.yml"), `version: "3"
tasks:
  test:
    desc: Run API tests
    summary: Exercise the API task suite
`, "utf8")

    const parsed = loadTaskfile(tempRoot)
    assert.notEqual(parsed, null)
    assert.equal(parsed?.tasks.verify.name, "verify")
    assert.equal(parsed?.tasks.verify.summary, "Verify the main project workflows")
    assert.equal(parsed?.tasks["api:test"]?.name, "api:test")
    assert.equal(parsed?.tasks["api:test"]?.namespace, "api")
    assert.equal(parsed?.tasks["api:test"]?.desc, "Run API tests")
    assert.equal(parsed?.tasks["api:test"]?.summary, "Exercise the API task suite")
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

function testHasSeparateTaskSummary() {
  assert.equal(__cleatInternals.hasSeparateTaskSummary({ desc: "", summary: "Only summary" }), false)
  assert.equal(__cleatInternals.hasSeparateTaskSummary({ desc: "Short desc", summary: "" }), false)
  assert.equal(__cleatInternals.hasSeparateTaskSummary({ desc: "Same", summary: "Same" }), false)
  assert.equal(__cleatInternals.hasSeparateTaskSummary({ desc: "Short desc", summary: "Longer details" }), true)
}

function testNoAlwaysLoadedSkills() {
  assert.deepEqual(__cleatInternals.getAlwaysLoadedSkills(), [])
}

function testNoGitDetectedExternalSkills() {
  const tempRoot = mkdtempSync(join(tmpdir(), "cleat-skills-"))

  try {
    mkdirSync(join(tempRoot, ".git"), { recursive: true })
    assert.deepEqual(__cleatInternals.detectProjectSkills(tempRoot), [])
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

async function testCleatCommandsAreRegistered() {
  const hooks = await CleatPlugin({
    client: {
      app: { log: async () => {} },
      session: { prompt: async () => {} },
    },
    project: {},
    directory: process.cwd(),
    worktree: process.cwd(),
    serverUrl: new URL("http://localhost"),
    $: undefined,
  } as any)

  const config: any = {}
  await (hooks as any).config?.(config)

  assert.equal(typeof config.command?.["cleat-scan-makefile"]?.description, "string")
  assert.equal(typeof config.command?.["cleat-plan-taskfile"]?.template, "string")
}

function testPackageRootImportAfterInstall() {
  const consumerDir = mkdtempSync(join(tmpdir(), "cleat-consumer-"))

  try {
    execFileSync("npm", ["init", "-y", "--prefix", consumerDir], { stdio: "pipe" })
    execFileSync("npm", ["install", "--prefix", consumerDir, "file:/home/jt/dev/jturmel/cleat"], { stdio: "pipe" })
    const imported = execFileSync(
      "node",
      ["--input-type=module", "-e", "import('cleat').then(() => process.stdout.write('ok\\n'))"],
      {
        cwd: consumerDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    )

    assert.equal(imported.trim(), "ok")
  } finally {
    rmSync(consumerDir, { recursive: true, force: true })
  }
}


async function run() {
  testParseSlashCommand()
  testSimpleMakefileClassification()
  testNestedIncludeDetection()
  testRiskAndDestructiveClassification()
  testShellHeavyTraitAndMapping()
  testPlanArtifactFromMapping()
  testOpinionatedRootSurfaceDefaults()
  testOpinionatedNamespaceNormalization()
  testDeployPromotePlacement()
  testProposedSurfaceConfidenceAndArtifact()
  testPromptQuestionPolicyUsesConfidence()
  testTaskfileParsingModule()
  testTaskfileLoadingModule()
  testHasSeparateTaskSummary()
  testNoAlwaysLoadedSkills()
  testNoGitDetectedExternalSkills()
  await testCleatCommandsAreRegistered()
  testPackageRootImportAfterInstall()
  process.stdout.write("cleat-plugin tests: PASS\n")
}

void run()
