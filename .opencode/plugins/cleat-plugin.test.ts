import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { join, dirname } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"

import { __cleatInternals } from "./cleat-plugin.js"
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


function run() {
  testParseSlashCommand()
  testSimpleMakefileClassification()
  testNestedIncludeDetection()
  testRiskAndDestructiveClassification()
  testShellHeavyTraitAndMapping()
  testPlanArtifactFromMapping()
  testTaskfileParsingModule()
  testTaskfileLoadingModule()
  testHasSeparateTaskSummary()
  process.stdout.write("cleat-plugin tests: PASS\n")
}

run()
