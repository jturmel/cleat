import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { join, dirname } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath, pathToFileURL } from "node:url"

import { CleatPlugin, __cleatInternals } from "../.opencode/plugins/cleat-plugin.js"
import { isDirectExecution } from "../.opencode/plugins/module-exec.js"
import { loadTaskfile, parseTaskfileYaml } from "../tasks.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, "..")
const fixtures = join(__dirname, "..", "fixtures")

function readFixture(name) {
  return readFileSync(join(fixtures, name), "utf8")
}

function testParseSlashCommand() {
  assert.equal(__cleatInternals.parseSlashCommand("/cleat-migrate-makefile"), "cleat-migrate-makefile")
  assert.equal(__cleatInternals.parseSlashCommand("cleat-scan-makefile"), "cleat-scan-makefile")
  assert.equal(__cleatInternals.parseSlashCommand("/not-a-cleat-command"), null)
}

function testDetectAutomationContext() {
  const tempRoot = mkdtempSync(join(tmpdir(), "cleat-context-"))

  try {
    mkdirSync(join(tempRoot, ".github", "workflows"), { recursive: true })
    mkdirSync(join(tempRoot, "taskfiles"), { recursive: true })
    writeFileSync(join(tempRoot, "Makefile"), "test:\n\techo test\n", "utf8")
    writeFileSync(join(tempRoot, "Taskfile.yaml"), 'version: "3"\n', "utf8")
    writeFileSync(join(tempRoot, ".github", "workflows", "ci.yml"), "name: CI\n", "utf8")
    writeFileSync(join(tempRoot, "README.md"), "# Test\n", "utf8")

    const context = __cleatInternals.detectAutomationContext(tempRoot)

    assert.equal(context.makefiles.length, 1)
    assert.equal(context.hasTaskfile, true)
    assert.equal(context.hasTaskfilesDir, true)
    assert.equal(context.ciFiles.includes(".github/workflows/ci.yml"), true)
    assert.equal(context.docFiles.includes("README.md"), true)
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
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

function testInferCanonicalTaskName() {
  assert.equal(__cleatInternals.inferCanonicalTaskName("run"), "dev")
  assert.equal(__cleatInternals.inferCanonicalTaskName("release-app"), "deploy")
  assert.equal(__cleatInternals.inferCanonicalTaskName("dj-migrate-prod"), "db:migrate:prod")
  assert.equal(__cleatInternals.inferCanonicalTaskName("check-all"), "verify")
  assert.equal(__cleatInternals.inferCanonicalTaskName("totally-custom-task"), null)
}

function testBuildNamespaceSuggestion() {
  assert.equal(__cleatInternals.buildNamespaceSuggestion("dj-test"), "verify")
  assert.equal(__cleatInternals.buildNamespaceSuggestion("gcp-deploy"), "deploy")
  assert.equal(__cleatInternals.buildNamespaceSuggestion("docker-up"), "dev")
  assert.equal(__cleatInternals.buildNamespaceSuggestion("fixture-seed"), "db")
}

function testMigrationPolicyRootSurfaceAndNamespaceGuidance() {
  const policy = __cleatInternals.buildMigrationPolicy()

  assert.equal(typeof policy.rootAggregateSemantics.build, "string")
  assert.equal(typeof policy.rootAggregateSemantics["build:clean"], "string")
  assert.equal(typeof policy.rootAggregateSemantics.clean, "string")
  assert.equal(typeof policy.rootAggregateSemantics.test, "string")
  assert.equal(typeof policy.rootAggregateSemantics.verify, "string")
  assert.equal(typeof policy.rootAggregateSemantics["verify:all"], "string")

  assert.equal(policy.namespaceGuidance.defaults.includes("db"), true)
  assert.equal(policy.namespaceGuidance.defaults.includes("infra"), true)
  assert.equal(policy.namespaceGuidance.conditional.includes("gcp"), true)
  assert.equal(policy.namespaceGuidance.preferInfraOver.includes("terraform"), true)
  assert.equal(policy.namespaceGuidance.excludedDefaults.includes("act"), true)
  assert.equal(policy.namespaceGuidance.excludedDefaults.includes("sfdc"), true)
  assert.equal(policy.namespaceGuidance.excludedDefaults.includes("native"), true)
}

function testInfraNamespacePreferredForTerraformTargets() {
  assert.equal(__cleatInternals.inferCanonicalTaskName("terraform-plan"), "infra:plan")
  assert.equal(__cleatInternals.inferCanonicalTaskName("tf-apply"), "infra:apply")
  assert.equal(__cleatInternals.buildNamespaceSuggestion("terraform-plan"), "infra")
}

function testScoreMigrationConfidenceNoPublicTargets() {
  const confidence = __cleatInternals.scoreMigrationConfidence({
    publicCount: 0,
    canonicalMatches: 0,
    ambiguousTargets: [],
    namespaceCount: 0,
    rootCount: 0,
  })

  assert.equal(confidence.level, "low")
  assert.equal(confidence.askQuestions, true)
  assert.equal(typeof confidence.score, "number")
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

function testMigrationCommandsIncludePolicyArtifact() {
  const tempRoot = mkdtempSync(join(tmpdir(), "cleat-policy-artifact-"))

  try {
    writeFileSync(join(tempRoot, "Makefile"), `
build:
	echo build

clean:
	docker compose down --volumes --rmi local
`, "utf8")

    const state = { artifacts: {} }
    const artifacts = __cleatInternals.buildCleatArtifactsForCommand("cleat-migrate-makefile", tempRoot, state)
    const policy = artifacts?.migrationPolicyArtifact?.data?.migrationPolicy

    assert.notEqual(policy, null)
    assert.equal(policy.canonicalLayout.rootTaskfile, "Taskfile.yaml")
    assert.equal(policy.cleanPolicy.composeMayRemove.includes("volumes"), true)
    assert.equal(policy.safetyPromptPolicy.preferredMechanism, "go-task prompt:")
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

function testPlanArtifactUsesCanonicalYamlGuidance() {
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
        },
      },
    },
  }

  const plan = __cleatInternals.buildPlanFromArtifacts(scanArtifact, mappingArtifact)

  assert.equal(plan.orderedSteps.some((step) => step.includes("Taskfile.yaml")), true)
  assert.equal(plan.orderedSteps.some((step) => step.includes("flatten: true")), true)
  assert.equal(plan.orderedSteps.some((step) => step.includes("taskfiles/_root.yaml")), true)
  assert.equal(plan.orderedSteps.some((step) => step.includes("taskfiles/scripts/")), true)
  assert.equal(plan.orderedSteps.some((step) => step.includes("silent: true")), true)
  assert.equal(plan.orderedSteps.some((step) => step.includes("build:clean")), true)
  assert.equal(plan.orderedSteps.some((step) => step.includes("verify:all")), true)
  assert.equal(plan.orderedSteps.some((step) => step.includes("project-scoped Compose services, images, and volumes")), true)
  assert.equal(plan.orderedSteps.some((step) => step.includes("go-task prompt:")), true)
}

function testPromptContainsCanonicalYamlGuidance() {
  const prompt = __cleatInternals.buildCleatPrompt(
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

  assert.equal(prompt.includes("Taskfile.yaml"), true)
  assert.equal(prompt.includes("taskfiles/_root.yaml"), true)
  assert.equal(prompt.includes("flatten: true"), true)
  assert.equal(prompt.includes("taskfiles/scripts/"), true)
  assert.equal(prompt.includes("silent: true"), true)
  assert.equal(prompt.includes("build:clean"), true)
  assert.equal(prompt.includes("verify:all"), true)
  assert.equal(prompt.includes("7-8 lines"), true)
  assert.equal(prompt.includes("project-scoped Compose services, images, and volumes"), true)
  assert.equal(prompt.includes("go-task prompt:"), true)
  assert.equal(prompt.includes("act:*"), false)
  assert.equal(prompt.includes("sfdc:*"), false)
  assert.equal(prompt.includes("native:*"), false)
}

function testMigrationPolicyUsesCanonicalYamlLayout() {
  const policy = __cleatInternals.buildMigrationPolicy()

  assert.equal(policy.canonicalLayout.rootTaskfile, "Taskfile.yaml")
  assert.equal(policy.canonicalLayout.rootTasksFile, "taskfiles/_root.yaml")
  assert.equal(policy.canonicalLayout.namespaceTaskfilePattern, "taskfiles/<namespace>.yaml")
  assert.equal(policy.canonicalLayout.scriptsDir, "taskfiles/scripts/")
  assert.equal(policy.canonicalLayout.generatedExtension, ".yaml")
  assert.equal(policy.migrationCompatibility.readLegacyYml, true)
  assert.equal(policy.migrationCompatibility.generateLegacyYml, false)
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

function testTaskfileLoadingWithMissingInclude() {
  const tempRoot = mkdtempSync(join(tmpdir(), "cleat-taskfile-missing-"))

  try {
    writeFileSync(join(tempRoot, "Taskfile.yml"), `version: "3"
includes:
  api:
    taskfile: ./taskfiles/api.yml
tasks:
  verify:
    desc: Verify everything
`, "utf8")

    const parsed = loadTaskfile(tempRoot)
    assert.notEqual(parsed, null)
    assert.equal(parsed?.tasks.verify.name, "verify")
    assert.equal(parsed?.tasks["api:test"], undefined)
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

function testTaskfilePrefersYamlWhenBothExist() {
  const tempRoot = mkdtempSync(join(tmpdir(), "cleat-taskfile-prefer-yaml-"))

  try {
    writeFileSync(join(tempRoot, "Taskfile.yaml"), `version: "3"
tasks:
  verify:
    desc: Verify yaml
`, "utf8")
    writeFileSync(join(tempRoot, "Taskfile.yml"), `version: "2"
tasks:
  verify:
    desc: Verify yml
`, "utf8")

    const parsed = loadTaskfile(tempRoot)
    assert.notEqual(parsed, null)
    assert.equal(parsed?.version, "3")
    assert.equal(parsed?.tasks.verify.desc, "Verify yaml")
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

function testTaskfileLoadingIncludeExtensionFallback() {
  const tempRoot = mkdtempSync(join(tmpdir(), "cleat-taskfile-fallback-"))

  try {
    mkdirSync(join(tempRoot, "taskfiles"), { recursive: true })
    writeFileSync(join(tempRoot, "Taskfile.yaml"), `version: "3"
includes:
  api:
    taskfile: ./taskfiles/api.yaml
tasks:
  verify:
    desc: Verify everything
    deps:
      - task: api:test
`, "utf8")
    writeFileSync(join(tempRoot, "taskfiles", "api.yml"), `version: "3"
tasks:
  test:
    desc: Run API tests
`, "utf8")

    const parsed = loadTaskfile(tempRoot)
    assert.notEqual(parsed, null)
    assert.equal(parsed?.tasks["api:test"]?.name, "api:test")
    assert.equal(parsed?.tasks["api:test"]?.desc, "Run API tests")
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

function testScanArtifactIncludesLegacyYmlRenameSuggestions() {
  const tempRoot = mkdtempSync(join(tmpdir(), "cleat-scan-legacy-yml-"))

  try {
    mkdirSync(join(tempRoot, "taskfiles"), { recursive: true })
    writeFileSync(join(tempRoot, "Taskfile.yml"), `version: "3"
includes:
  api:
    taskfile: ./taskfiles/api.yml
`, "utf8")
    writeFileSync(join(tempRoot, "taskfiles", "api.yml"), `version: "3"
tasks:
  test:
    desc: Run API tests
`, "utf8")
    writeFileSync(join(tempRoot, "taskfiles", "db.yaml"), `version: "3"
tasks:
  migrate:
    desc: Run migrations
`, "utf8")

    const state = { artifacts: {} }
    const artifacts = __cleatInternals.buildCleatArtifactsForCommand("cleat-scan-makefile", tempRoot, state)
    const scanData = artifacts?.scanArtifact?.data

    assert.equal(Array.isArray(scanData?.taskfileInventory?.renameSuggestions), true)
    assert.equal(scanData.taskfileInventory.renameSuggestions.some((item) => item.from === "Taskfile.yml" && item.to === "Taskfile.yaml"), true)
    assert.equal(scanData.taskfileInventory.renameSuggestions.some((item) => item.from === "taskfiles/api.yml" && item.to === "taskfiles/api.yaml"), true)
    assert.equal(scanData.taskfileInventory.renameSuggestions.some((item) => item.from === "taskfiles/db.yaml"), false)
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

function testIsDirectExecutionHelper() {
  assert.equal(isDirectExecution("file:///tmp/example.mjs", undefined), false)

  const scriptPath = join(tmpdir(), "cleat-direct-run-check.mjs")
  const scriptUrl = pathToFileURL(scriptPath).href

  assert.equal(isDirectExecution(scriptUrl, scriptPath), true)
  assert.equal(isDirectExecution(scriptUrl, join(tmpdir(), "different-script.mjs")), false)
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
    execFileSync("npm", ["init", "-y"], { cwd: consumerDir, stdio: "pipe" })
    execFileSync("npm", ["install", `file:${repoRoot}`], { cwd: consumerDir, stdio: "pipe" })
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

function testPackageRootImportFromPackedTarball() {
  const consumerDir = mkdtempSync(join(tmpdir(), "cleat-consumer-packed-"))
  const packDir = mkdtempSync(join(tmpdir(), "cleat-pack-"))
  let tarballPath = ""

  try {
    const packJson = execFileSync("npm", ["pack", "--json", "--pack-destination", packDir], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })
    const jsonStart = packJson.indexOf("[")
    const jsonEnd = packJson.lastIndexOf("]")
    const jsonPayload = jsonStart >= 0 && jsonEnd >= jsonStart ? packJson.slice(jsonStart, jsonEnd + 1) : "[]"
    const packed = JSON.parse(jsonPayload)
    assert.equal(Array.isArray(packed) && packed.length > 0, true)
    const packedFiles = Array.isArray(packed[0]?.files) ? packed[0].files : []
    assert.equal(packedFiles.some((file) => String(file?.path || "").startsWith("tests/")), false)
    tarballPath = join(packDir, packed[0].filename)

    execFileSync("npm", ["init", "-y"], { cwd: consumerDir, stdio: "pipe" })
    execFileSync("npm", ["install", tarballPath], { cwd: consumerDir, stdio: "pipe" })
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
    rmSync(packDir, { recursive: true, force: true })
    if (tarballPath) {
      rmSync(tarballPath, { force: true })
    }
  }
}


async function run() {
  testParseSlashCommand()
  testDetectAutomationContext()
  testSimpleMakefileClassification()
  testNestedIncludeDetection()
  testRiskAndDestructiveClassification()
  testShellHeavyTraitAndMapping()
  testPlanArtifactFromMapping()
  testOpinionatedRootSurfaceDefaults()
  testOpinionatedNamespaceNormalization()
  testDeployPromotePlacement()
  testInferCanonicalTaskName()
  testBuildNamespaceSuggestion()
  testMigrationPolicyRootSurfaceAndNamespaceGuidance()
  testInfraNamespacePreferredForTerraformTargets()
  testScoreMigrationConfidenceNoPublicTargets()
  testProposedSurfaceConfidenceAndArtifact()
  testMigrationCommandsIncludePolicyArtifact()
  testPromptQuestionPolicyUsesConfidence()
  testPlanArtifactUsesCanonicalYamlGuidance()
  testPromptContainsCanonicalYamlGuidance()
  testMigrationPolicyUsesCanonicalYamlLayout()
  testTaskfileParsingModule()
  testTaskfileLoadingModule()
  testTaskfileLoadingWithMissingInclude()
  testTaskfilePrefersYamlWhenBothExist()
  testTaskfileLoadingIncludeExtensionFallback()
  testScanArtifactIncludesLegacyYmlRenameSuggestions()
  testHasSeparateTaskSummary()
  testNoAlwaysLoadedSkills()
  testNoGitDetectedExternalSkills()
  testIsDirectExecutionHelper()
  await testCleatCommandsAreRegistered()
  testPackageRootImportAfterInstall()
  testPackageRootImportFromPackedTarball()
  process.stdout.write("cleat-plugin tests: PASS\n")
}

if (isDirectExecution(import.meta.url, process.argv[1])) {
  void run()
}
