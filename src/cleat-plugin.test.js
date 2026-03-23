import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { __cleatInternals } from "./cleat-plugin.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixtures = join(__dirname, "..", "fixtures")

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

function run() {
  testParseSlashCommand()
  testSimpleMakefileClassification()
  testNestedIncludeDetection()
  testRiskAndDestructiveClassification()
  testShellHeavyTraitAndMapping()
  testPlanArtifactFromMapping()
  process.stdout.write("cleat-plugin tests: PASS\n")
}

run()
