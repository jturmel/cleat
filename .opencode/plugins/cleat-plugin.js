import { tool } from "@opencode-ai/plugin";
import { loadTaskfile, parseTaskfileYaml, resolveRootTaskfilePath, } from "../../tasks.js";
import { execSync, spawn } from "child_process";
import { existsSync, readFileSync, readdirSync } from "fs";
import { join, relative } from "path";
import { homedir } from "os";
/**
 * Dynamic cleat plugin for OpenCode
 *
 * Features:
 * 1. Parses Taskfile.yaml/Taskfile.yml and included taskfiles to build:
 *    - Task categories from namespaces
 *    - Intent mappings from descriptions
 *    - Safety metadata from naming patterns
 *
 * 2. Auto-injects skills on session start:
 *    - Always-on skills (workflow/process skills)
 *    - Project-detected skills (e.g., Taskfile.yaml → go-task skill)
 *
 * Works across any go-task project without hardcoding.
 */
// ============================================================================
// AUTO-SKILLS CONFIGURATION
// ============================================================================
// Skills that should always be loaded (workflow/process skills)
const ALWAYS_LOAD_SKILLS = [];
// Skills loaded based on project file detection
const PROJECT_DETECTION_RULES = [];
// Skill search paths (in priority order, later overrides earlier)
const SKILL_SEARCH_PATHS = [
    // Global paths
    join(homedir(), ".config/opencode/skills"),
    join(homedir(), ".claude/skills"),
    join(homedir(), ".agents/skills"),
];
const ROUTING_ADVISOR_ENABLED = process.env.CLEAT_ROUTING_ADVISOR === "1";
const ROUTING_STARTUP_MAX_CHARS = 700;
const ROUTING_REINFORCE_MAX_CHARS = 300;
const ROUTING_REINFORCE_COOLDOWN_MS = 300000;
const ROUTING_REINFORCE_MAX_PER_SESSION = 2;
const ROUTING_MISS_THRESHOLD = 3;
const TASK_TOOL_NAMES = new Set(["task_recommend", "task_list", "task_help", "task_run"]);
const TASK_INTENT_KEYWORDS = ["task", "lint", "test", "build", "verify", "migrate"];
const CLEAT_COMMANDS = new Set([
    "cleat-migrate-makefile",
    "cleat-scan-makefile",
    "cleat-map-make-targets",
    "cleat-plan-taskfile",
    "cleat-shore-up-taskfile",
]);
const CLEAT_COMMAND_CONFIG = {
    "cleat-migrate-makefile": {
        description: "Migrate Makefile workflows to Taskfile structure",
        template: "Run the cleat migration workflow.\n\n$ARGUMENTS",
    },
    "cleat-scan-makefile": {
        description: "Scan current Makefile/task automation context",
        template: "Run the cleat scan workflow.\n\n$ARGUMENTS",
    },
    "cleat-map-make-targets": {
        description: "Map Makefile targets into go-task namespaces",
        template: "Run the cleat target mapping workflow.\n\n$ARGUMENTS",
    },
    "cleat-plan-taskfile": {
        description: "Create or update a Taskfile migration plan",
        template: "Run the cleat planning workflow.\n\n$ARGUMENTS",
    },
    "cleat-shore-up-taskfile": {
        description: "Harden Taskfile safety and command parity",
        template: "Run the cleat shore-up workflow.\n\n$ARGUMENTS",
    },
};
const CLEAT_POLICY = {
    structure: [
        "Prefer curated root front-door tasks for common workflows.",
        "Keep implementation ownership in namespaces.",
        "Use internal helper tasks for plumbing.",
        "Extract non-trivial inline shell into scripts.",
    ],
    safety: [
        "Classify operations into safe, risky, destructive.",
        "Flag production-like operations and require guard patterns.",
        "Prefer explicit variants for production paths.",
    ],
    uncertainty: [
        "Preserve behavior first.",
        "Prefer compatibility aliases over silent breaking renames.",
        "Insert manual review checkpoints when intent is ambiguous.",
    ],
};
function buildMigrationPolicy() {
    return {
        canonicalLayout: {
            rootTaskfile: "Taskfile.yaml",
            rootTasksFile: "taskfiles/_root.yaml",
            namespaceTaskfilePattern: "taskfiles/<namespace>.yaml",
            scriptsDir: "taskfiles/scripts/",
            generatedExtension: ".yaml",
            rootTaskfileRole: "index-only",
            rootTasksFileRole: "root aggregates and front-door workflows",
        },
        migrationCompatibility: {
            readLegacyYml: true,
            generateLegacyYml: false,
            guidance: "Read existing Taskfile.yml files for compatibility, but generate and recommend .yaml paths only.",
        },
        rootAggregateSemantics: {
            build: "Run the normal build set.",
            "build:clean": "Clean safe/generated build outputs for the build scope, then run build.",
            clean: "Clear project-owned local artifacts aggressively enough to start fresh without touching unrelated host/global resources.",
            test: "Run the normal test suite.",
            verify: "Run fast day-to-day verification.",
            "verify:all": "Run comprehensive verification, including heavier checks when present.",
        },
        namespaceGuidance: {
            defaults: ["db", "infra"],
            conditional: ["gcp"],
            inferredPackageExamples: ["api", "web", "worker", "admin"],
            preferInfraOver: ["tf", "terraform"],
            excludedDefaults: ["act", "sfdc", "native"],
        },
        inlineScriptPolicy: {
            keepInlineWhen: [
                "single-command task",
                "short shell snippet of roughly 7-8 lines or fewer",
            ],
            extractToScriptsWhen: [
                "longer than roughly 7-8 lines",
                "requires set -euo pipefail",
                "uses branching",
                "uses loops",
                "uses cleanup traps",
                "needs meaningful comments",
                "is reused across tasks",
            ],
            scriptsDir: "taskfiles/scripts/",
        },
        cleanPolicy: {
            rootCleanScope: "project-owned local artifacts",
            composeMayRemove: ["services", "images", "volumes"],
            preserve: ["unrelated host/global Docker resources", "resources outside the project scope"],
            explicitDestructiveVariants: ["clean:volumes", "db:reset", "docker:prune"],
        },
        safetyPromptPolicy: {
            preferredMechanism: "go-task prompt:",
            avoidByDefault: "hand-rolled interactive shell read prompts",
            promptTaskPatterns: [
                "db:migrate:prod",
                "db:reset",
                "db:reset:prod",
                "clean when it removes volumes",
                "clean:volumes",
                "deploy:*",
                "infra:apply",
                "mutating gcp:* tasks",
            ],
        },
    };
}
const cleatArtifactsBySession = new Map();
const routingStateBySession = new Map();
function getTaskSearchText(task) {
    return [task.desc, task.summary].filter(Boolean).join(" ");
}
function getTaskDisplayText(task) {
    const raw = task.desc || task.summary;
    if (!raw)
        return "(no description)";
    // Normalize to a single line: trim and collapse all whitespace (including newlines)
    return raw.trim().replace(/\s+/g, " ");
}
function hasSeparateTaskSummary(task) {
    return Boolean(task.desc && task.summary && task.summary !== task.desc);
}
function getRoutingState(sessionID) {
    if (!routingStateBySession.has(sessionID)) {
        routingStateBySession.set(sessionID, {
            startupInjected: false,
            missScore: 0,
            reinforcementCount: 0,
            lastReinforcedAt: 0,
            sentHashes: new Set(),
            recentTools: [],
        });
    }
    return routingStateBySession.get(sessionID);
}
function hashPayload(input) {
    let hash = 0;
    for (let i = 0; i < input.length; i++) {
        hash = (hash << 5) - hash + input.charCodeAt(i);
        hash |= 0;
    }
    return String(hash);
}
function getCleatState(sessionID) {
    if (!cleatArtifactsBySession.has(sessionID)) {
        cleatArtifactsBySession.set(sessionID, {
            artifacts: {},
            decisionLog: [],
            updatedAt: Date.now(),
        });
    }
    return cleatArtifactsBySession.get(sessionID);
}
function makeArtifact(stage, sourceCommand, data) {
    return {
        stage,
        timestamp: new Date().toISOString(),
        sourceCommand,
        data,
    };
}
function parseSlashCommand(inputCommand) {
    const raw = String(inputCommand || "").trim();
    if (!raw)
        return null;
    const token = raw.split(/\s+/)[0].replace(/^\//, "");
    if (!CLEAT_COMMANDS.has(token))
        return null;
    return token;
}
function readTextIfExists(path) {
    if (!existsSync(path))
        return "";
    try {
        return readFileSync(path, "utf8");
    }
    catch {
        return "";
    }
}
function collectTaskfileRelatedFiles(worktree) {
    const discovered = [];
    for (const rootName of ["Taskfile.yaml", "Taskfile.yml"]) {
        const rootPath = join(worktree, rootName);
        if (existsSync(rootPath)) {
            discovered.push(rootPath);
        }
    }
    const taskfilesRoot = join(worktree, "taskfiles");
    if (existsSync(taskfilesRoot)) {
        const walk = (current) => {
            const entries = readdirSync(current, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = join(current, entry.name);
                if (entry.isDirectory()) {
                    walk(fullPath);
                    continue;
                }
                if (entry.isFile() && /\.ya?ml$/i.test(entry.name)) {
                    discovered.push(fullPath);
                }
            }
        };
        walk(taskfilesRoot);
    }
    return Array.from(new Set(discovered))
        .map((path) => relative(worktree, path).replace(/\\/g, "/"))
        .sort();
}
function buildLegacyTaskfileRenameSuggestions(discoveredFiles) {
    return discoveredFiles
        .filter((path) => path.endsWith(".yml"))
        .map((from) => ({
        from,
        to: `${from.slice(0, -4)}.yaml`,
        reason: "Legacy .yml Taskfile-related file; prefer .yaml for canonical output.",
    }));
}
function detectAutomationContext(worktree) {
    const makefileCandidates = ["Makefile", "makefile", "GNUmakefile"];
    const makefiles = makefileCandidates
        .map((name) => join(worktree, name))
        .filter((path) => existsSync(path));
    const ciFiles = [
        ".github/workflows/ci.yml",
        ".github/workflows/test.yml",
        ".gitlab-ci.yml",
        "azure-pipelines.yml",
    ].filter((path) => existsSync(join(worktree, path)));
    const docFiles = ["README.md", "TASKS.md", "AGENTS.md"].filter((path) => existsSync(join(worktree, path)));
    return {
        worktree,
        makefiles,
        hasTaskfile: Boolean(resolveRootTaskfilePath(worktree)),
        hasTaskfilesDir: existsSync(join(worktree, "taskfiles")),
        ciFiles,
        docFiles,
    };
}
function parseMakefileDetails(content) {
    const lines = content.split("\n");
    const includes = [];
    const phony = new Set();
    const targets = [];
    let currentTarget = null;
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#"))
            continue;
        if (/^include\s+/i.test(trimmed)) {
            const includeValue = trimmed.replace(/^include\s+/i, "").trim();
            includes.push(includeValue);
            continue;
        }
        if (/^\.PHONY\s*:/i.test(trimmed)) {
            const rest = trimmed.split(":")[1] || "";
            for (const item of rest.split(/\s+/).filter(Boolean)) {
                phony.add(item);
            }
            continue;
        }
        const isRecipeLine = /^\t/.test(line);
        if (isRecipeLine && currentTarget) {
            currentTarget.recipeLineCount += 1;
            continue;
        }
        const match = line.match(/^([A-Za-z0-9_./%-]+(?:\s+[A-Za-z0-9_./%-]+)*)\s*:(.*)$/);
        if (!match) {
            currentTarget = null;
            continue;
        }
        if (line.includes("=") && !line.startsWith(" ")) {
            currentTarget = null;
            continue;
        }
        const targetNames = match[1].split(/\s+/).filter(Boolean);
        const deps = (match[2] || "").trim().split(/\s+/).filter(Boolean);
        for (const name of targetNames) {
            const target = {
                name,
                deps,
                recipeLineCount: 0,
                isPhony: false,
            };
            targets.push(target);
            currentTarget = target;
        }
    }
    for (const target of targets) {
        target.isPhony = phony.has(target.name);
    }
    return {
        includes,
        phony: Array.from(phony),
        targets,
    };
}
function classifyMakeTarget(target) {
    const value = target.name.toLowerCase();
    const destructivePatterns = ["reset", "flush", "drop", "destroy", "wipe", "delete", "nuke"];
    const riskyPatterns = ["migrate", "deploy", "promote", "release", "publish", "prod"];
    const safePatterns = ["list", "show", "check", "status", "help", "lint", "test", "build"];
    let risk = "risky";
    if (destructivePatterns.some((pattern) => value.includes(pattern))) {
        risk = "destructive";
    }
    else if (safePatterns.some((pattern) => value.includes(pattern))) {
        risk = "safe";
    }
    const role = (value.startsWith("_") || value.includes("helper") || value.includes("internal"))
        ? "helper"
        : "public";
    const traits = {
        prod_like: riskyPatterns.some((pattern) => value.includes(pattern)),
        shell_heavy: target.recipeLineCount >= 3,
        depends_on_many: target.deps.length >= 4,
    };
    return {
        name: target.name,
        role,
        risk,
        traits,
    };
}
function inferCanonicalTaskName(name) {
    const lower = name.toLowerCase();
    if (lower === "dev" || lower === "run" || lower === "start")
        return "dev";
    if (lower.includes("deploy") || lower.includes("release") || lower.includes("publish")) {
        return "deploy";
    }
    if (lower.includes("promote"))
        return "deploy:promote";
    if (lower.includes("terraform") || lower.includes("tofu") || lower.startsWith("tf-")) {
        if (lower.includes("apply"))
            return "infra:apply";
        if (lower.includes("plan"))
            return "infra:plan";
        if (lower.includes("destroy"))
            return "infra:destroy";
        if (lower.includes("init"))
            return "infra:init";
        return "infra";
    }
    if (lower.includes("migrate")) {
        if (lower.includes("prod") || lower.includes("production"))
            return "db:migrate:prod";
        return "db:migrate";
    }
    if ((lower.includes("load") || lower.includes("seed")) && (lower.includes("fixture") || lower.includes("data"))) {
        return "db:load";
    }
    if (lower.includes("dump") && lower.includes("data"))
        return "db:dump";
    if (lower.includes("lint"))
        return "verify:lint";
    if (lower.includes("test"))
        return "test";
    if (lower.includes("check") || lower.includes("verify") || lower.includes("ci"))
        return "verify";
    if (lower.includes("build"))
        return "build";
    if (lower.includes("frontend") || lower.includes("vite") || lower.includes("tailwind"))
        return "frontend:build";
    if (lower.includes("run-maintenance") || lower.includes("maintenance"))
        return "dev:maintenance";
    if (lower.includes("dev"))
        return "dev";
    return null;
}
function buildNamespaceSuggestion(name) {
    const canonical = inferCanonicalTaskName(name);
    if (canonical) {
        if (canonical.includes(":"))
            return canonical.split(":")[0];
        if (["test", "verify"].includes(canonical))
            return "verify";
        if (canonical === "build")
            return "frontend";
        if (canonical === "deploy")
            return "deploy";
        if (canonical === "dev")
            return "dev";
    }
    const lower = name.toLowerCase();
    if (lower.includes("db") || lower.includes("fixture"))
        return "db";
    if (lower.includes("terraform") || lower.includes("tofu") || lower.startsWith("tf-") || lower.includes("infra"))
        return "infra";
    if (lower.includes("docker") || lower.includes("compose"))
        return "dev";
    return "dev";
}
function buildPolicyScore(mapping) {
    const rootCount = (mapping.recommendedRoot || []).length;
    const namespaceCount = Object.keys(mapping.namespaceMap).length;
    const safetyCount = mapping.safetyRecommendations.length;
    const extractionCount = mapping.scriptExtractionCandidates.length;
    return {
        rootSurfaceQuality: rootCount > 0 && rootCount <= 8 ? "good" : "review",
        namespaceClarity: namespaceCount >= 2 ? "good" : "review",
        safetyCoverage: safetyCount > 0 ? "good" : "review",
        scriptExtractionNeeded: extractionCount > 0 ? "yes" : "no",
        docVerificationFollowup: "required",
    };
}
function scoreMigrationConfidence({ publicCount, canonicalMatches, ambiguousTargets, namespaceCount, rootCount }) {
    if (publicCount === 0) {
        return {
            score: 0.45,
            level: "low",
            askQuestions: true,
            reasons: ["No public targets were detected, so migration intent is ambiguous."],
        };
    }
    const coverage = canonicalMatches / publicCount;
    const ambiguityRate = ambiguousTargets.length / publicCount;
    let score = 0;
    score += coverage * 0.5;
    score += Math.min(namespaceCount / 3, 1) * 0.2;
    score += rootCount > 0 ? 0.15 : 0;
    score += ambiguityRate === 0 ? 0.15 : Math.max(0, 0.15 - ambiguityRate * 0.2);
    const normalizedScore = Number(score.toFixed(2));
    const level = normalizedScore >= 0.75 ? "high" : normalizedScore >= 0.55 ? "medium" : "low";
    const reasons = [];
    if (coverage < 0.6) {
        reasons.push("Canonical naming coverage is limited across public targets.");
    }
    if (namespaceCount < 2) {
        reasons.push("Only a narrow namespace set was inferred.");
    }
    if (ambiguousTargets.length > 0) {
        reasons.push(`Unmapped targets: ${ambiguousTargets.slice(0, 5).join(", ")}`);
    }
    if (!reasons.length) {
        reasons.push("Canonical naming coverage and namespace clarity are strong.");
    }
    return {
        score: normalizedScore,
        level,
        askQuestions: level !== "high" || ambiguousTargets.length > 0,
        reasons,
    };
}
function buildProposedSurface(mapping, classifications) {
    const namespaces = {};
    const normalizedTasks = [];
    const productionVariants = [];
    const ambiguousTargets = [];
    let canonicalMatches = 0;
    let publicCount = 0;
    for (const item of classifications) {
        if (item.role !== "public")
            continue;
        publicCount += 1;
        const canonical = inferCanonicalTaskName(item.name);
        if (!canonical) {
            ambiguousTargets.push(item.name);
            continue;
        }
        canonicalMatches += 1;
        normalizedTasks.push(canonical);
        if (canonical.includes(":")) {
            const namespace = canonical.split(":")[0];
            if (!namespaces[namespace])
                namespaces[namespace] = [];
            namespaces[namespace].push(canonical);
        }
        if (canonical.endsWith(":prod") || item.traits.prod_like) {
            productionVariants.push(canonical);
        }
    }
    const uniqueNamespaces = Object.fromEntries(Object.entries(namespaces).map(([name, tasks]) => [name, Array.from(new Set(tasks)).sort()]));
    const confidence = scoreMigrationConfidence({
        publicCount,
        canonicalMatches,
        ambiguousTargets,
        namespaceCount: Object.keys(uniqueNamespaces).length,
        rootCount: (mapping.recommendedRoot || []).length,
    });
    const questionFocus = ambiguousTargets.map((target) => ({
        target,
        reason: "No clear canonical mapping detected",
    }));
    return {
        rootEntrypoints: mapping.recommendedRoot || [],
        namespaces: uniqueNamespaces,
        normalizedTasks: Array.from(new Set(normalizedTasks)).sort(),
        renameSuggestions: mapping.renameSuggestions || [],
        internalHelpers: mapping.internalCandidates || [],
        productionVariants: Array.from(new Set(productionVariants)).sort(),
        ambiguities: ambiguousTargets,
        questionFocus,
        confidence,
    };
}
function buildMappingFromClassifications(classifications) {
    const rootCandidates = [];
    const internalCandidates = [];
    const namespaceMap = {};
    const scriptExtractionCandidates = [];
    const safetyRecommendations = [];
    const renameSuggestions = [];
    const rootSet = new Set();
    const signals = {
        hasTest: false,
        hasLint: false,
        hasBuild: false,
        hasDeploy: false,
        hasDev: false,
    };
    for (const item of classifications) {
        const namespace = buildNamespaceSuggestion(item.name);
        if (!namespaceMap[namespace])
            namespaceMap[namespace] = [];
        namespaceMap[namespace].push(item.name);
        const canonical = inferCanonicalTaskName(item.name);
        if (canonical && canonical !== item.name) {
            renameSuggestions.push({
                from: item.name,
                to: canonical,
            });
        }
        if (canonical === "dev" || namespace === "dev")
            signals.hasDev = true;
        if (canonical === "build")
            signals.hasBuild = true;
        if (canonical === "test")
            signals.hasTest = true;
        if (canonical === "verify" || (canonical || "").startsWith("verify:"))
            signals.hasLint = true;
        if (canonical === "deploy" || (canonical || "").startsWith("deploy:"))
            signals.hasDeploy = true;
        if (item.role === "helper") {
            internalCandidates.push(item.name);
        }
        else if (item.risk === "safe") {
            rootCandidates.push(item.name);
        }
        if (item.traits.shell_heavy) {
            scriptExtractionCandidates.push(item.name);
        }
        if (item.risk === "destructive") {
            safetyRecommendations.push(`${item.name}: require explicit destructive confirmation (for example CONFIRM=yes)`);
        }
        else if (item.risk === "risky" || item.traits.prod_like) {
            safetyRecommendations.push(`${item.name}: require risky confirmation and explicit production variant review`);
        }
    }
    if (signals.hasDev)
        rootSet.add("dev");
    if (signals.hasBuild)
        rootSet.add("build");
    if (signals.hasTest)
        rootSet.add("test");
    if (signals.hasTest || signals.hasLint || signals.hasBuild)
        rootSet.add("verify");
    if (signals.hasDeploy)
        rootSet.add("deploy");
    if (signals.hasTest && signals.hasLint && signals.hasBuild) {
        renameSuggestions.push({ from: "(aggregate)", to: "verify:all" });
    }
    const mapping = {
        rootCandidates,
        recommendedRoot: Array.from(rootSet),
        namespaceMap,
        internalCandidates,
        scriptExtractionCandidates,
        safetyRecommendations,
        renameSuggestions,
    };
    const proposedSurface = buildProposedSurface(mapping, classifications);
    return {
        ...mapping,
        proposedSurface,
        policyScore: buildPolicyScore(mapping),
    };
}
function buildPlanFromArtifacts(scanArtifact, mappingArtifact) {
    const hasTaskfile = !!scanArtifact?.data?.context?.hasTaskfile;
    const steps = [
        "Review scan report and confirm migration goals.",
        "Create/adjust Taskfile.yaml as a minimal index with flatten: true and import taskfiles/_root.yaml.",
        "Create/update taskfiles/_root.yaml with root/front-door tasks and standard aggregates where signaled: build, build:clean, clean, test, verify, verify:all.",
        "Create/update namespaced taskfiles as taskfiles/*.yaml based on generic domains such as db:* and infra:* plus inferred package/domain namespaces.",
        "Keep one-command tasks and shell snippets of roughly 7-8 lines or fewer inline with silent: true; extract longer or complex shell to taskfiles/scripts/.",
        "Make clean clear project-scoped Compose services, images, and volumes when those resources are local to the project; avoid unrelated host/global cleanup.",
        "Use go-task prompt: for risky or destructive tasks such as db:migrate:prod, db:reset, clean with volumes, deploy:*, and infra:apply.",
        "Update docs and verify command parity.",
    ];
    return {
        hasExistingTaskfile: hasTaskfile,
        namespaces: Object.keys(mappingArtifact?.data?.mapping?.namespaceMap || {}),
        orderedSteps: steps,
        verification: [
            "Run task --list to verify discoverability.",
            "Run task --summary build, task --summary test, and task --summary verify when those tasks exist.",
            "Run task --summary clean and inspect prompt:/scope before executing destructive cleanup.",
            "Confirm risky and destructive paths use go-task prompt: or explicit non-interactive alternatives.",
        ],
        candidateDiffHints: [],
    };
}
function buildCleatPrompt(commandName, state, artifacts) {
    const stageByCommand = {
        "cleat-migrate-makefile": "guided",
        "cleat-scan-makefile": "scan",
        "cleat-map-make-targets": "map",
        "cleat-plan-taskfile": "plan",
        "cleat-shore-up-taskfile": "shore-up",
    };
    const stage = stageByCommand[commandName] || "guided";
    const priorStages = Object.keys(state.artifacts);
    const proposedSurface = artifacts?.proposedSurfaceArtifact?.data?.proposedSurface
        || artifacts?.mappingArtifact?.data?.mapping?.proposedSurface
        || null;
    const confidence = proposedSurface?.confidence || null;
    const ambiguityCount = Array.isArray(proposedSurface?.ambiguities) ? proposedSurface.ambiguities.length : 0;
    const questionPolicyLine = confidence?.askQuestions
        ? `Question policy: ask one focused question only for unresolved ambiguities (count: ${ambiguityCount}).`
        : "Question policy: do not ask structural preference questions; apply defaults unless user or repo constraints require overrides.";
    const confidenceLine = confidence
        ? `Migration confidence: ${confidence.level} (${confidence.score}).`
        : "Migration confidence: unavailable.";
    const payload = {
        command: `/${commandName}`,
        stage,
        policy: CLEAT_POLICY,
        artifacts,
        priorStages,
        behavior: {
            askOneQuestionAtATime: true,
            preserveBehaviorFirst: true,
            explainWhyForRecommendations: true,
            stageAddressableOutputs: true,
        },
    };
    return [
        `You are executing ${payload.command}.`,
        "Guide the user through Makefile-to-go-task migration with structured outputs.",
        "Apply cleat house style first: canonical .yaml layout, minimal root index, root aggregates in taskfiles/_root.yaml, and normalized task naming.",
        "Canonical output shape: root Taskfile.yaml uses flatten: true and imports taskfiles/_root.yaml; namespace workflows live in taskfiles/<namespace>.yaml; helper scripts live in taskfiles/scripts/.",
        "Generated guidance uses .yaml only. Read existing Taskfile.yml files for compatibility, but recommend renaming Taskfile-related .yml files to .yaml.",
        "Preferred root aggregate semantics when matching signals exist: build, build:clean, clean, test, verify, verify:all.",
        "Keep one-command tasks and shell snippets of roughly 7-8 lines or fewer inline with silent: true; extract longer or complex shell into taskfiles/scripts/.",
        "Clean guidance: root clean may remove project-scoped Compose services, images, and volumes when clearly local to the project; avoid unrelated host/global cleanup.",
        "Safety guidance: use go-task prompt: for risky or destructive tasks instead of hand-rolled shell read prompts.",
        "Preferred namespaces: db:* for database workflows, infra:* for IaC workflows, gcp:* only when Google Cloud is clearly present, and inferred package/domain namespaces from project signals.",
        "Default-first behavior: present a strong recommended layout and ask questions only when ambiguity or repo conflicts materially affect outcomes.",
        "Preferred normalization examples: db:migrate, db:load, verify:lint, test, verify:all.",
        questionPolicyLine,
        confidenceLine,
        "Emit artifacts using the provided schema fields (stage, timestamp, sourceCommand, data).",
        "Use policy rules to justify recommendations (structure, safety, uncertainty).",
        `Current stage: ${payload.stage}.`,
        `Known prior stages: ${priorStages.join(", ") || "none"}.`,
        `Artifact payload: ${JSON.stringify(payload.artifacts, null, 2)}`,
    ].join("\n\n");
}
function buildCleatArtifactsForCommand(commandName, worktree, state) {
    const context = detectAutomationContext(worktree);
    const makefilePath = context.makefiles[0];
    const makefileContent = makefilePath ? readTextIfExists(makefilePath) : "";
    const makefileData = makefileContent ? parseMakefileDetails(makefileContent) : { includes: [], phony: [], targets: [] };
    const taskfileRelatedFiles = collectTaskfileRelatedFiles(worktree);
    const taskfileRenameSuggestions = buildLegacyTaskfileRenameSuggestions(taskfileRelatedFiles);
    const classifications = makefileData.targets.map((target) => classifyMakeTarget(target));
    const mapping = buildMappingFromClassifications(classifications);
    const scanArtifact = makeArtifact("scan", `/${commandName}`, {
        context,
        taskfileInventory: {
            discoveredFiles: taskfileRelatedFiles,
            legacyYmlFiles: taskfileRelatedFiles.filter((path) => path.endsWith(".yml")),
            renameSuggestions: taskfileRenameSuggestions,
        },
        makefile: {
            path: makefilePath || null,
            includes: makefileData.includes,
            phony: makefileData.phony,
            targetCount: makefileData.targets.length,
        },
    });
    const classificationArtifact = makeArtifact("classify", `/${commandName}`, {
        classifications,
    });
    const mappingArtifact = makeArtifact("map", `/${commandName}`, {
        mapping,
    });
    const proposedSurfaceArtifact = makeArtifact("proposed-surface", `/${commandName}`, {
        proposedSurface: mapping.proposedSurface,
    });
    const migrationPolicyArtifact = makeArtifact("migration-policy", `/${commandName}`, {
        migrationPolicy: buildMigrationPolicy(),
    });
    const planArtifact = makeArtifact("plan", `/${commandName}`, {
        plan: buildPlanFromArtifacts(scanArtifact, mappingArtifact),
    });
    const artifactsByCommand = {
        "cleat-scan-makefile": { scanArtifact, migrationPolicyArtifact },
        "cleat-map-make-targets": {
            scanArtifact: state.artifacts.scanArtifact || scanArtifact,
            classificationArtifact: state.artifacts.classificationArtifact || classificationArtifact,
            mappingArtifact,
            proposedSurfaceArtifact,
            migrationPolicyArtifact,
        },
        "cleat-plan-taskfile": {
            scanArtifact: state.artifacts.scanArtifact || scanArtifact,
            mappingArtifact: state.artifacts.mappingArtifact || mappingArtifact,
            proposedSurfaceArtifact: state.artifacts.proposedSurfaceArtifact || proposedSurfaceArtifact,
            migrationPolicyArtifact: state.artifacts.migrationPolicyArtifact || migrationPolicyArtifact,
            planArtifact,
        },
        "cleat-shore-up-taskfile": {
            classificationArtifact,
            mappingArtifact,
            proposedSurfaceArtifact,
            migrationPolicyArtifact,
        },
        "cleat-migrate-makefile": {
            scanArtifact: state.artifacts.scanArtifact || scanArtifact,
            classificationArtifact: state.artifacts.classificationArtifact || classificationArtifact,
            mappingArtifact: state.artifacts.mappingArtifact || mappingArtifact,
            proposedSurfaceArtifact: state.artifacts.proposedSurfaceArtifact || proposedSurfaceArtifact,
            migrationPolicyArtifact: state.artifacts.migrationPolicyArtifact || migrationPolicyArtifact,
            planArtifact,
        },
    };
    return artifactsByCommand[commandName] || { scanArtifact };
}
function buildStartupRoutingGuidance() {
    const text = "Use go-task tools for task workflows. Prefer exact-match execution first: if the user gives a specific task name, run task_run directly (for example: task_run task=\"verify:all\"). Use task_help when the task name is close/uncertain, task_recommend when intent is known but task name is unknown, and task_list only for broad discovery. Avoid raw shell task commands; use task tools so safety/help/progress behavior is preserved.";
    return text.slice(0, ROUTING_STARTUP_MAX_CHARS);
}
function buildRoutingReinforcement(reason, tool, example) {
    const text = `Detected likely task-tool miss (${reason}). Prefer task_run first when task name is known; otherwise use ${tool}. Example: ${example}. Avoid raw shell task commands for this flow.`;
    return text.slice(0, ROUTING_REINFORCE_MAX_CHARS);
}
function addMissScore(sessionID, points) {
    const state = getRoutingState(sessionID);
    state.missScore += points;
    return state.missScore;
}
function canReinforceRouting(state, now) {
    if (state.reinforcementCount >= ROUTING_REINFORCE_MAX_PER_SESSION)
        return false;
    if (state.missScore < ROUTING_MISS_THRESHOLD)
        return false;
    if (now - state.lastReinforcedAt < ROUTING_REINFORCE_COOLDOWN_MS)
        return false;
    return true;
}
async function sendSessionPromptWithRetry(ctx, sessionID, text) {
    const params = {
        path: { id: sessionID },
        body: {
            parts: [{ type: "text", text }],
            noReply: true,
        },
    };
    try {
        await ctx.client.session.prompt(params);
        return true;
    }
    catch (err) {
        await ctx.client.app.log({
            service: "cleat-plugin",
            level: "warn",
            message: `session prompt failed for ${sessionID}`,
            extra: { error: String(err) },
        });
    }
    try {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        await ctx.client.session.prompt(params);
        return true;
    }
    catch (retryErr) {
        await ctx.client.app.log({
            service: "cleat-plugin",
            level: "error",
            message: `session prompt retry failed for ${sessionID}`,
            extra: { error: String(retryErr) },
        });
        return false;
    }
}
async function maybeInjectStartupRouting(ctx, sessionID) {
    if (!ROUTING_ADVISOR_ENABLED)
        return;
    const state = getRoutingState(sessionID);
    if (state.startupInjected)
        return;
    const text = buildStartupRoutingGuidance();
    const key = hashPayload(`startup:${sessionID}:${text}`);
    if (state.sentHashes.has(key))
        return;
    const sent = await sendSessionPromptWithRetry(ctx, sessionID, text);
    if (!sent)
        return;
    state.sentHashes.add(key);
    state.startupInjected = true;
}
async function maybeSendRoutingReinforcement(ctx, sessionID, reason, tool, example) {
    if (!ROUTING_ADVISOR_ENABLED)
        return;
    const state = getRoutingState(sessionID);
    const now = Date.now();
    if (!canReinforceRouting(state, now))
        return;
    const text = buildRoutingReinforcement(reason, tool, example);
    const key = hashPayload(`reinforce:${sessionID}:${text}`);
    if (state.sentHashes.has(key))
        return;
    const sent = await sendSessionPromptWithRetry(ctx, sessionID, text);
    if (!sent)
        return;
    state.sentHashes.add(key);
    state.reinforcementCount += 1;
    state.lastReinforcedAt = now;
}
async function recordRoutingMiss(ctx, sessionID, reason, points) {
    const state = getRoutingState(sessionID);
    addMissScore(sessionID, points);
    await ctx.client.app.log({
        service: "cleat-plugin",
        level: "info",
        message: "routing miss score incremented",
        extra: { sessionID, reason, points, missScore: state.missScore },
    });
}
// ============================================================================
// AUTO-SKILLS FUNCTIONS
// ============================================================================
function findSkillFile(skillName, projectDir) {
    // Build full search paths including project-local (highest priority last)
    const searchPaths = [
        ...SKILL_SEARCH_PATHS,
        // Project-local (highest priority)
        join(projectDir, ".opencode/skills"),
        join(projectDir, ".claude/skills"),
        join(projectDir, ".agents/skills"),
    ];
    for (const basePath of searchPaths) {
        const skillPath = join(basePath, skillName, "SKILL.md");
        if (existsSync(skillPath)) {
            return skillPath;
        }
    }
    return null;
}
function loadSkillContent(skillName, projectDir) {
    const skillPath = findSkillFile(skillName, projectDir);
    if (!skillPath) {
        return null;
    }
    try {
        return readFileSync(skillPath, "utf-8");
    }
    catch {
        return null;
    }
}
function detectProjectSkills(projectDir) {
    const detectedSkills = [];
    for (const rule of PROJECT_DETECTION_RULES) {
        for (const file of rule.files) {
            const filePath = join(projectDir, file);
            if (existsSync(filePath)) {
                if (!detectedSkills.includes(rule.skill)) {
                    detectedSkills.push(rule.skill);
                }
                break; // Found one file, move to next rule
            }
        }
    }
    return detectedSkills;
}
function getAlwaysLoadedSkills() {
    return [...ALWAYS_LOAD_SKILLS];
}
function formatSkillInjection(skillName, content) {
    return `<skill_content name="${skillName}">
${content}
</skill_content>

<system-reminder>
The above skill "${skillName}" was auto-loaded at session start.
Follow its instructions as part of your workflow.
</system-reminder>`;
}
// ============================================================================
// DYNAMIC CATEGORIZATION
// ============================================================================
function buildCategories(tasks) {
    const categories = {};
    const rootTasks = [];
    for (const [name, task] of Object.entries(tasks)) {
        if (task.internal)
            continue;
        if (name.includes(":")) {
            const [namespace] = name.split(":");
            if (!categories[namespace]) {
                categories[namespace] = {
                    name: namespace,
                    tasks: [],
                    description: `${namespace} tasks`
                };
            }
            categories[namespace].tasks.push(task);
        }
        else {
            rootTasks.push(task);
        }
    }
    // Add root category if there are root tasks
    if (rootTasks.length > 0) {
        categories["root"] = {
            name: "root",
            tasks: rootTasks,
            description: "Top-level tasks (preferred entrypoints)"
        };
    }
    // Enhance category descriptions based on common patterns
    const categoryDescriptions = {
        dev: "Development environment tasks",
        docker: "Docker compose operations",
        django: "Django management commands",
        db: "Database operations (migrations, fixtures, reset)",
        test: "Testing tasks",
        verify: "Validation and CI checks",
        build: "Build and compilation tasks",
        frontend: "Frontend asset tasks",
        backend: "Backend service tasks",
        python: "Python dependency management",
        gcp: "Google Cloud Platform operations",
        terraform: "Infrastructure as code operations",
        deploy: "Deployment tasks",
        lint: "Linting and code quality",
        root: "Top-level tasks (preferred entrypoints)"
    };
    for (const [name, cat] of Object.entries(categories)) {
        if (categoryDescriptions[name]) {
            cat.description = categoryDescriptions[name];
        }
    }
    return categories;
}
// ============================================================================
// DYNAMIC INTENT MAPPING
// ============================================================================
function buildIntentMappings(tasks) {
    const intents = {};
    // Keywords to intent patterns
    const intentPatterns = [
        { keywords: ["start", "run", "up", "dev"], intent: "start development" },
        { keywords: ["test", "tests", "testing"], intent: "run tests" },
        { keywords: ["lint", "check", "verify", "validate"], intent: "validate code" },
        { keywords: ["build", "compile", "assets"], intent: "build" },
        { keywords: ["deploy", "release", "publish"], intent: "deploy" },
        { keywords: ["migrate", "migration"], intent: "run migrations" },
        { keywords: ["reset", "clean", "clear"], intent: "reset" },
        { keywords: ["stop", "down", "shutdown"], intent: "stop" },
        { keywords: ["install", "setup", "init"], intent: "setup" },
        { keywords: ["log", "logs"], intent: "view logs" },
        { keywords: ["fixture", "seed", "load"], intent: "load data" },
        { keywords: ["dump", "export", "backup"], intent: "export data" }
    ];
    for (const [name, task] of Object.entries(tasks)) {
        if (task.internal)
            continue;
        const nameLower = name.toLowerCase();
        const searchText = getTaskSearchText(task);
        const searchTextLower = searchText.toLowerCase();
        const combined = `${nameLower} ${searchTextLower}`;
        for (const pattern of intentPatterns) {
            for (const keyword of pattern.keywords) {
                if (combined.includes(keyword)) {
                    if (!intents[pattern.intent]) {
                        intents[pattern.intent] = [];
                    }
                    // Score based on how well it matches
                    let score = 0;
                    if (nameLower.includes(keyword))
                        score += 2;
                    if (searchTextLower.includes(keyword))
                        score += 1;
                    // Prefer root tasks
                    if (!name.includes(":"))
                        score += 3;
                    // Prefer shorter names
                    score += Math.max(0, 10 - name.length) / 10;
                    intents[pattern.intent].push({ task: name, desc: task.desc, summary: task.summary, score });
                    break;
                }
            }
        }
    }
    // Sort each intent's tasks by score and keep best matches
    for (const intent of Object.keys(intents)) {
        intents[intent].sort((a, b) => b.score - a.score);
    }
    return intents;
}
// ============================================================================
// SAFETY DETECTION
// ============================================================================
function detectSafety(taskName, taskDesc) {
    const name = taskName.toLowerCase();
    const desc = (taskDesc || "").toLowerCase();
    const combined = `${name} ${desc}`;
    // Destructive patterns
    const destructivePatterns = [
        "reset", "flush", "drop", "delete", "destroy", "remove", "clean",
        "force", "hard", "nuke", "wipe"
    ];
    // Production patterns
    const productionPatterns = [
        ":prod", "production", "deploy", "promote", "release", "migrate:prod"
    ];
    // Safe patterns
    const safePatterns = [
        "list", "show", "check", "status", "log", "ps", "info", "help",
        "diff", "inspect", "view", "get"
    ];
    if (destructivePatterns.some(p => combined.includes(p))) {
        return { level: "destructive", warning: "This task may cause data loss" };
    }
    if (productionPatterns.some(p => combined.includes(p))) {
        return { level: "production", warning: "This task affects production" };
    }
    if (safePatterns.some(p => combined.includes(p))) {
        return { level: "safe", warning: null };
    }
    return { level: "normal", warning: null };
}
// ============================================================================
// TASK EXECUTION
// ============================================================================
function runGoTask(args, worktree, timeout = 30000) {
    const result = runGoTaskDetailed(args, worktree, timeout);
    return result.output;
}
function runGoTaskDetailed(args, worktree, timeout = 30000) {
    const cmd = `go-task ${args.join(" ")}`;
    try {
        const output = execSync(cmd, {
            cwd: worktree,
            encoding: "utf8",
            timeout,
            stdio: ["pipe", "pipe", "pipe"]
        }).trim();
        return {
            ok: true,
            output,
            cmd,
        };
    }
    catch (error) {
        const stdout = error.stdout ? String(error.stdout).trim() : "";
        const stderr = error.stderr ? String(error.stderr).trim() : "";
        let output = "";
        if (stdout && stderr) {
            output = `${stdout}\n\nError: ${stderr}`;
        }
        else if (stdout) {
            output = stdout;
        }
        else if (stderr) {
            output = `Error: ${stderr}`;
        }
        else {
            output = `Error executing task: ${error.message}`;
        }
        return {
            ok: false,
            output,
            cmd,
            error,
        };
    }
}
function runGoTaskDetailedAsync(args, worktree, timeout = 300000, hooks = {}) {
    const { onHeartbeat } = hooks;
    return new Promise((resolve) => {
        const child = spawn("go-task", args, {
            cwd: worktree,
            stdio: ["ignore", "pipe", "pipe"],
        });
        const cmd = `go-task ${args.join(" ")}`;
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        const startedAt = Date.now();
        const heartbeatTimer = setInterval(() => {
            if (!onHeartbeat)
                return;
            const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
            onHeartbeat(elapsedSeconds);
        }, 15000);
        const timeoutTimer = setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
            setTimeout(() => {
                try {
                    child.kill("SIGKILL");
                }
                catch {
                    // Process may already be dead
                }
            }, 5000);
        }, timeout);
        const cleanup = () => {
            clearInterval(heartbeatTimer);
            clearTimeout(timeoutTimer);
        };
        child.stdout.on("data", (chunk) => {
            stdout += String(chunk);
        });
        child.stderr.on("data", (chunk) => {
            stderr += String(chunk);
        });
        child.on("error", (error) => {
            cleanup();
            resolve({
                ok: false,
                output: `Error executing task: ${error.message}`,
                cmd,
                error,
            });
        });
        child.on("close", (code) => {
            cleanup();
            const trimmedStdout = stdout.trim();
            const trimmedStderr = stderr.trim();
            if (!timedOut && code === 0) {
                resolve({
                    ok: true,
                    output: trimmedStdout,
                    cmd,
                });
                return;
            }
            let output = "";
            if (timedOut) {
                output = `Error: Command timed out after ${Math.floor(timeout / 1000)}s`;
                if (trimmedStdout) {
                    output += `\n\n${trimmedStdout}`;
                }
            }
            else if (trimmedStdout && trimmedStderr) {
                output = `${trimmedStdout}\n\nError: ${trimmedStderr}`;
            }
            else if (trimmedStdout) {
                output = trimmedStdout;
            }
            else if (trimmedStderr) {
                output = `Error: ${trimmedStderr}`;
            }
            else {
                output = `Error executing task (exit code ${code ?? "unknown"})`;
            }
            resolve({
                ok: false,
                output,
                cmd,
                exitCode: code,
            });
        });
    });
}
function buildTaskExecutionSteps(taskName, data) {
    const task = data.tasks[taskName];
    if (!task)
        return null;
    const ordered = [];
    const activePath = new Set();
    function visit(name) {
        const current = data.tasks[name];
        if (!current) {
            ordered.push(name);
            return;
        }
        if (activePath.has(name)) {
            ordered.push(name);
            return;
        }
        activePath.add(name);
        const canExpand = current.deps && current.deps.length > 0 && current.hasNonTaskCommands !== true;
        if (!canExpand) {
            ordered.push(name);
            activePath.delete(name);
            return;
        }
        for (const dep of current.deps) {
            visit(dep);
        }
        activePath.delete(name);
    }
    visit(taskName);
    const seen = new Set();
    const deduped = [];
    for (const name of ordered) {
        if (seen.has(name))
            continue;
        seen.add(name);
        deduped.push(name);
    }
    return deduped;
}
async function emitProgressLog(ctx, context, message) {
    try {
        await ctx.client.app.log({
            service: "cleat-plugin",
            level: "info",
            message: `[task_run][${context.sessionID}] ${message}`,
            extra: {
                sessionID: context.sessionID,
            },
        });
    }
    catch {
        // Non-fatal: progress logging should never break task execution
    }
}
async function emitProgressMessage(ctx, context, message) {
    try {
        context.metadata({
            title: `Progress: ${message}`,
            metadata: {
                progress: message,
                progressTimestamp: new Date().toISOString(),
            },
        });
        // Metadata updates may only appear after tool completion in some UIs.
        // Emit non-heartbeat progress as TUI toasts for live, non-chat updates.
        if (!message.startsWith("Running ")) {
            await ctx.client.tui.showToast({
                title: "go-task progress",
                message,
                variant: "info",
                duration: 1800,
            });
        }
    }
    catch {
        // Non-fatal: progress messages are best-effort
    }
}
function getTaskListFromCli(worktree, all = false) {
    const args = all ? ["--list-all"] : ["--list"];
    const output = runGoTask(args, worktree);
    const tasks = [];
    const lines = output.split("\n");
    for (const line of lines) {
        const match = line.match(/^\*\s+(\S+):\s*(.+)$/);
        if (match) {
            tasks.push({
                name: match[1],
                desc: match[2].trim(),
                summary: "",
            });
        }
    }
    return tasks;
}
// ============================================================================
// CACHE
// ============================================================================
const cache = new Map();
function getProjectData(worktree) {
    const cacheKey = worktree;
    const cached = cache.get(cacheKey);
    // Cache for 30 seconds
    if (cached && Date.now() - cached.timestamp < 30000) {
        return cached.data;
    }
    // Try parsing Taskfile.yaml/Taskfile.yml first
    let parsed = loadTaskfile(worktree);
    // Fallback to CLI if parsing fails or no tasks found
    if (!parsed || Object.keys(parsed.tasks).length === 0) {
        const cliTasks = getTaskListFromCli(worktree, true);
        parsed = {
            version: null,
            tasks: {},
            includes: {},
        };
        for (const t of cliTasks) {
            parsed.tasks[t.name] = {
                name: t.name,
                desc: t.desc,
                summary: t.summary,
                internal: t.name.startsWith("_"),
                deps: [],
                hasNonTaskCommands: false,
                namespace: t.name.includes(":") ? t.name.split(":")[0] : undefined,
            };
        }
    }
    const categories = buildCategories(parsed.tasks);
    const intents = buildIntentMappings(parsed.tasks);
    const data = {
        tasks: parsed.tasks,
        includes: parsed.includes,
        categories,
        intents
    };
    cache.set(cacheKey, { data, timestamp: Date.now() });
    return data;
}
// ============================================================================
// PLUGIN EXPORT
// ============================================================================
export const CleatPlugin = async (ctx) => {
    return {
        config: async (config) => {
            config.command = config.command || {};
            for (const [name, commandConfig] of Object.entries(CLEAT_COMMAND_CONFIG)) {
                config.command[name] = {
                    description: commandConfig.description,
                    template: commandConfig.template,
                };
            }
        },
        tool: {
            // Tool names are prefixed in TUI display, so:
            // - "task_list" displays as "task_list <title>"
            // - "task_help" displays as "task_help <title>"
            // - "task_recommend" displays as "task_recommend <title>"
            // - "task_run" displays as "task_run <title>"
            task_list: tool({
                description: "List available go-task tasks. Use to discover what tasks exist in a project. Categories are auto-detected from namespaces.",
                args: {
                    category: tool.schema.string().optional().describe("Filter by category/namespace (e.g., 'docker', 'django', 'test', 'root')"),
                    includeInternal: tool.schema.boolean().optional().describe("Include internal (_prefixed) tasks (default: false)")
                },
                async execute(args, context) {
                    const { worktree } = context;
                    // Set display title for the UI (shows after tool name)
                    const title = args.category ? args.category : "";
                    context.metadata({ title });
                    if (!resolveRootTaskfilePath(worktree)) {
                        return `No Taskfile.yaml or Taskfile.yml found in ${worktree}. This project doesn't use go-task.`;
                    }
                    const data = getProjectData(worktree);
                    let output = "";
                    // List available categories
                    const categoryNames = Object.keys(data.categories).sort();
                    if (args.category) {
                        const cat = data.categories[args.category];
                        if (!cat) {
                            return `Unknown category "${args.category}".\n\nAvailable categories: ${categoryNames.join(", ")}`;
                        }
                        output = `## ${args.category.toUpperCase()} - ${cat.description}\n\n`;
                        for (const task of cat.tasks) {
                            if (task.internal && !args.includeInternal)
                                continue;
                            const safety = detectSafety(task.name, getTaskSearchText(task));
                            const safetyBadge = safety.level === "destructive" ? " [DESTRUCTIVE]" :
                                safety.level === "production" ? " [PRODUCTION]" : "";
                            output += `- \`${task.name}\`${safetyBadge}: ${getTaskDisplayText(task)}\n`;
                        }
                        return output;
                    }
                    // Show all categories with task counts
                    output = "## Available Task Categories\n\n";
                    for (const catName of categoryNames) {
                        const cat = data.categories[catName];
                        const publicTasks = cat.tasks.filter(t => !t.internal);
                        output += `### ${catName} (${publicTasks.length} tasks)\n`;
                        output += `${cat.description}\n\n`;
                        // Show first 5 tasks as preview
                        const preview = publicTasks.slice(0, 5);
                        for (const task of preview) {
                            output += `- \`${task.name}\`: ${getTaskDisplayText(task)}\n`;
                        }
                        if (publicTasks.length > 5) {
                            output += `- ... and ${publicTasks.length - 5} more\n`;
                        }
                        output += "\n";
                    }
                    output += `\nUse \`task_list category:<name>\` to see all tasks in a category.`;
                    return output;
                }
            }),
            task_help: tool({
                description: "Get detailed help for a specific task including safety info, related tasks, and usage examples",
                args: {
                    task: tool.schema.string().describe("Task name (e.g., 'test', 'db:migrate', 'django:test-module')")
                },
                async execute(args, context) {
                    const { worktree } = context;
                    // Set display title for the UI (shows after tool name)
                    context.metadata({ title: args.task });
                    if (!resolveRootTaskfilePath(worktree)) {
                        return `No Taskfile.yaml or Taskfile.yml found in ${worktree}.`;
                    }
                    const data = getProjectData(worktree);
                    const task = data.tasks[args.task];
                    if (!task) {
                        // Suggest similar tasks
                        const allNames = Object.keys(data.tasks);
                        const similar = allNames.filter(n => n.includes(args.task) || args.task.includes(n.split(":").pop())).slice(0, 5);
                        let msg = `Task "${args.task}" not found.`;
                        if (similar.length > 0) {
                            msg += `\n\nDid you mean:\n${similar.map(n => `- ${n}`).join("\n")}`;
                        }
                        msg += "\n\nUse `task_list` to see available tasks.";
                        return msg;
                    }
                    const safety = detectSafety(task.name, getTaskSearchText(task));
                    let output = `## ${task.name}\n\n`;
                    output += `**Description:** ${getTaskDisplayText(task)}\n\n`;
                    if (task.summary && task.desc && task.summary !== task.desc) {
                        output += `**Summary:**\n${task.summary}\n\n`;
                    }
                    // Category
                    if (task.namespace) {
                        const cat = data.categories[task.namespace];
                        if (cat) {
                            output += `**Category:** ${task.namespace} - ${cat.description}\n\n`;
                        }
                    }
                    else {
                        output += `**Category:** root - Top-level task (preferred entrypoint)\n\n`;
                    }
                    // Safety
                    if (safety.level !== "normal") {
                        output += `**Safety Level:** ${safety.level.toUpperCase()}`;
                        if (safety.warning) {
                            output += ` - ${safety.warning}`;
                        }
                        output += "\n\n";
                    }
                    // Dependencies
                    if (task.deps && task.deps.length > 0) {
                        output += `**Runs:** ${task.deps.join(" → ")}\n\n`;
                    }
                    // Usage
                    output += "**Usage:**\n```bash\n";
                    output += `task ${task.name}\n`;
                    // Add common argument patterns
                    if (task.name.includes("test-module") || task.name.includes("test:module")) {
                        output += `task ${task.name} MODULE=path.to.tests\n`;
                    }
                    if (task.name.includes("test-one") || task.name.includes("test:one")) {
                        output += `task ${task.name} TEST=path.to.TestClass.test_method\n`;
                    }
                    if (task.name.includes("django:") && !task.name.includes("test")) {
                        output += `task ${task.name} -- --additional-args\n`;
                    }
                    output += "```\n\n";
                    // Related tasks (same namespace)
                    if (task.namespace) {
                        const related = data.categories[task.namespace]?.tasks
                            .filter(t => t.name !== task.name && !t.internal)
                            .slice(0, 5);
                        if (related && related.length > 0) {
                            output += "**Related Tasks:**\n";
                            for (const r of related) {
                                output += `- \`${r.name}\`: ${getTaskDisplayText(r)}\n`;
                            }
                        }
                    }
                    return output;
                }
            }),
            task_recommend: tool({
                description: "Recommend the best task for a given intent. Use when you know WHAT you want to do but not WHICH task to use.",
                args: {
                    intent: tool.schema.string().describe("What you want to accomplish (e.g., 'run tests', 'start development', 'deploy')"),
                    context: tool.schema.string().optional().describe("Additional context (e.g., 'specific test', 'production', 'clean environment')")
                },
                async execute(args, context) {
                    const { worktree } = context;
                    // Set display title for the UI (shows after tool name)
                    context.metadata({ title: args.intent });
                    if (!resolveRootTaskfilePath(worktree)) {
                        return `No Taskfile.yaml or Taskfile.yml found in ${worktree}.`;
                    }
                    const data = getProjectData(worktree);
                    const intentLower = args.intent.toLowerCase();
                    const ctxLower = (args.context || "").toLowerCase();
                    // Find matching intents
                    let matches = [];
                    for (const [intent, tasks] of Object.entries(data.intents)) {
                        if (intentLower.includes(intent) || intent.includes(intentLower)) {
                            matches.push(...tasks.map((t) => ({ ...t, intent })));
                        }
                    }
                    // Also do keyword search across all tasks
                    const keywords = intentLower.split(/\s+/);
                    for (const [name, task] of Object.entries(data.tasks)) {
                        if (task.internal)
                            continue;
                        const combined = `${name} ${getTaskSearchText(task)}`.toLowerCase();
                        let keywordScore = 0;
                        for (const kw of keywords) {
                            if (kw.length > 2 && combined.includes(kw)) {
                                keywordScore += 1;
                            }
                        }
                        if (keywordScore > 0 && !matches.find(m => m.task === name)) {
                            matches.push({
                                task: name,
                                desc: task.desc,
                                summary: task.summary,
                                score: keywordScore,
                                intent: "keyword match"
                            });
                        }
                    }
                    // Apply context modifiers
                    if (ctxLower) {
                        for (const match of matches) {
                            const taskLower = match.task.toLowerCase();
                            const descLower = `${match.desc || ""} ${match.summary || ""}`.toLowerCase();
                            // Boost/penalize based on context
                            if (ctxLower.includes("clean") || ctxLower.includes("fresh")) {
                                if (taskLower.includes("clean") || taskLower.includes("reset")) {
                                    match.score += 3;
                                }
                            }
                            if (ctxLower.includes("ci") || ctxLower.includes("pipeline")) {
                                if (taskLower.includes("verify") || taskLower.includes("full")) {
                                    match.score += 3;
                                }
                            }
                            if (ctxLower.includes("production") || ctxLower.includes("prod")) {
                                if (taskLower.includes("prod")) {
                                    match.score += 3;
                                }
                            }
                            if (ctxLower.includes("specific") || ctxLower.includes("single") || ctxLower.includes("one")) {
                                if (taskLower.includes("one") || taskLower.includes("module")) {
                                    match.score += 3;
                                }
                            }
                        }
                    }
                    // Sort by score
                    matches.sort((a, b) => b.score - a.score);
                    if (matches.length === 0) {
                        let output = `No tasks found matching "${args.intent}".\n\n`;
                        output += "**Available intents:**\n";
                        for (const intent of Object.keys(data.intents).slice(0, 10)) {
                            output += `- ${intent}\n`;
                        }
                        output += "\nTry rephrasing or use `task_list` to browse all tasks.";
                        return output;
                    }
                    // Return top recommendation with alternatives
                    const top = matches[0];
                    const safety = detectSafety(top.task, `${top.desc || ""} ${top.summary || ""}`);
                    let output = `## Recommended: \`task ${top.task}\`\n\n`;
                    output += `**Description:** ${top.desc || top.summary || "(no description)"}\n\n`;
                    if (hasSeparateTaskSummary(top)) {
                        output += `**Summary:**\n${top.summary}\n\n`;
                    }
                    if (safety.level !== "normal" && safety.level !== "safe") {
                        output += `**Safety:** ${safety.level.toUpperCase()}`;
                        if (safety.warning)
                            output += ` - ${safety.warning}`;
                        output += "\n\n";
                    }
                    output += "**Run with:**\n```bash\n";
                    output += `task ${top.task}\n`;
                    output += "```\n\n";
                    // Alternatives
                    const alts = matches.slice(1, 4);
                    if (alts.length > 0) {
                        output += "**Alternatives:**\n";
                        for (const alt of alts) {
                            output += `- \`${alt.task}\`: ${alt.desc || alt.summary || "(no description)"}\n`;
                        }
                    }
                    return output;
                }
            }),
            task_run: tool({
                description: "Execute a go-task command. Use this first when the task name is known; use task_recommend/task_help when the task is unknown or ambiguous.",
                args: {
                    task: tool.schema.string().describe("Task name to execute"),
                    args: tool.schema.string().optional().describe("Additional arguments (e.g., 'MODULE=web.tests' or '-- --email me@example.com')"),
                    dryRun: tool.schema.boolean().optional().describe("Show what would be executed without running (default: false)")
                },
                async execute(args, context) {
                    const { worktree } = context;
                    const isDryRun = args.dryRun === true;
                    const fullCommand = args.args
                        ? `${args.task} ${args.args}`
                        : args.task;
                    // Set display title for the UI (shows after tool name)
                    context.metadata({ title: fullCommand });
                    if (!resolveRootTaskfilePath(worktree)) {
                        return `No Taskfile.yaml or Taskfile.yml found in ${worktree}.`;
                    }
                    const data = getProjectData(worktree);
                    const task = data.tasks[args.task];
                    // Warn if task not found in our parsed data (might still work via CLI)
                    const taskExists = !!task || args.task.includes("*");
                    if (isDryRun) {
                        let output = `## Dry Run\n\n`;
                        output += `**Command:** \`${fullCommand}\`\n\n`;
                        if (task) {
                            output += `**Description:** ${getTaskDisplayText(task)}\n`;
                            if (task.summary && task.summary !== task.desc) {
                                output += `**Summary:**\n${task.summary}\n`;
                            }
                            const safety = detectSafety(task.name, getTaskSearchText(task));
                            if (safety.level !== "normal" && safety.level !== "safe") {
                                output += `**Safety:** ${safety.level.toUpperCase()}`;
                                if (safety.warning)
                                    output += ` - ${safety.warning}`;
                                output += "\n";
                            }
                        }
                        else if (!taskExists) {
                            output += `**Warning:** Task "${args.task}" not found in parsed tasks. It may still work if it's a dynamic task.\n`;
                        }
                        output += `\nTo skip execution, run with \`dryRun: true\``;
                        return output;
                    }
                    const canRunAsSteps = !args.args && !args.task.includes("*") && taskExists;
                    if (canRunAsSteps) {
                        const steps = buildTaskExecutionSteps(args.task, data);
                        if (steps && steps.length > 1) {
                            const outputs = [];
                            for (let index = 0; index < steps.length; index++) {
                                const stepTask = steps[index];
                                const stepLabel = `[${index + 1}/${steps.length}] ${stepTask}`;
                                const stepResult = await runGoTaskDetailedAsync([stepTask], worktree, 300000);
                                const stepTaskData = data.tasks[stepTask];
                                const stepDesc = stepTaskData ? getTaskDisplayText(stepTaskData) : "";
                                const heading = stepDesc
                                    ? `### ${stepLabel} - ${stepDesc}`
                                    : `### ${stepLabel}`;
                                outputs.push(`${heading}\n\n${stepResult.output || "(no output)"}`);
                                if (!stepResult.ok) {
                                    return `## Executed as task-level run: \`task ${args.task}\`\n\nFailed at step ${index + 1} of ${steps.length}: \`${stepTask}\`\n\n${outputs.join("\n\n")}`;
                                }
                            }
                            return `## Executed as task-level run: \`task ${args.task}\`\n\n${outputs.join("\n\n")}`;
                        }
                    }
                    // Fallback: execute as a single task command
                    context.metadata({ title: fullCommand });
                    await emitProgressLog(ctx, context, `start single-task run ${fullCommand}`);
                    await emitProgressMessage(ctx, context, `Starting ${fullCommand}`);
                    const singleResult = await runGoTaskDetailedAsync(args.args ? [args.task, ...args.args.split(" ")] : [args.task], worktree, 300000, // 5 minute timeout for long-running tasks
                    {
                        onHeartbeat: (elapsedSeconds) => {
                            void emitProgressLog(ctx, context, `running single-task run ${fullCommand} (${elapsedSeconds}s)`);
                            void emitProgressMessage(ctx, context, `Running ${fullCommand} (${elapsedSeconds}s elapsed)`);
                        },
                    });
                    if (!singleResult.ok) {
                        await emitProgressLog(ctx, context, `failed single-task run ${fullCommand}`);
                        await emitProgressMessage(ctx, context, `Failed ${fullCommand}`);
                        return `## Executed: \`task ${fullCommand}\`\n\n${singleResult.output}`;
                    }
                    await emitProgressLog(ctx, context, `completed single-task run ${fullCommand}`);
                    await emitProgressMessage(ctx, context, `Completed ${fullCommand}`);
                    return `## Executed: \`task ${fullCommand}\`\n\n${singleResult.output}`;
                }
            })
        },
        // ========================================================================
        // AUTO-SKILLS: Inject skills on session start
        // ========================================================================
        event: async ({ event }) => {
            // Only trigger on new session creation
            if (event.type !== "session.created") {
                return;
            }
            const sessionId = event.properties.session.id;
            const projectDir = ctx.directory;
            const skillsToLoad = new Set();
            await maybeInjectStartupRouting(ctx, sessionId);
            // Add always-on skills
            for (const skill of ALWAYS_LOAD_SKILLS) {
                skillsToLoad.add(skill);
            }
            // Add project-detected skills
            const projectSkills = detectProjectSkills(projectDir);
            for (const skill of projectSkills) {
                skillsToLoad.add(skill);
            }
            // Load and inject each skill
            const loadedSkills = [];
            const failedSkills = [];
            for (const skillName of skillsToLoad) {
                const content = loadSkillContent(skillName, projectDir);
                if (!content) {
                    failedSkills.push(skillName);
                    continue;
                }
                try {
                    await ctx.client.session.prompt({
                        path: { id: sessionId },
                        body: {
                            parts: [
                                {
                                    type: "text",
                                    text: formatSkillInjection(skillName, content),
                                },
                            ],
                            noReply: true,
                        },
                    });
                    loadedSkills.push(skillName);
                }
                catch (err) {
                    failedSkills.push(skillName);
                }
            }
            // Log results
            if (loadedSkills.length > 0 || failedSkills.length > 0) {
                await ctx.client.app.log({
                    service: "cleat-plugin",
                    level: "info",
                    message: `Auto-loaded skills: [${loadedSkills.join(", ")}]${failedSkills.length > 0 ? ` | Failed: [${failedSkills.join(", ")}]` : ""}`,
                });
            }
        },
        "command.execute.before": async (input, output) => {
            const commandName = parseSlashCommand(input.command);
            if (!commandName)
                return;
            const sessionState = getCleatState(input.sessionID);
            const artifacts = buildCleatArtifactsForCommand(commandName, ctx.worktree, sessionState);
            // Persist stage-addressable artifacts for resume behavior
            Object.assign(sessionState.artifacts, artifacts);
            sessionState.updatedAt = Date.now();
            if (!Array.isArray(output.parts)) {
                output.parts = [];
            }
            output.parts.push({
                type: "text",
                text: buildCleatPrompt(commandName, sessionState, artifacts),
            });
            await ctx.client.app.log({
                service: "cleat-plugin",
                level: "info",
                message: `handled /${commandName}`,
                extra: {
                    sessionID: input.sessionID,
                    command: input.command,
                    stages: Object.keys(sessionState.artifacts),
                },
            });
        },
        "tool.execute.before": async (input, _output) => {
            if (!ROUTING_ADVISOR_ENABLED)
                return;
            const state = getRoutingState(input.sessionID);
            state.recentTools.push(input.tool);
            if (state.recentTools.length > 2) {
                state.recentTools.shift();
            }
        },
        "tool.execute.after": async (input, output) => {
            if (!ROUTING_ADVISOR_ENABLED)
                return;
            const sessionID = input.sessionID;
            const state = getRoutingState(sessionID);
            const toolName = String(input.tool || "");
            const args = input.args || {};
            const command = typeof args.command === "string" ? args.command.trim() : "";
            const textOutput = typeof output?.output === "string" ? output.output : "";
            let missReason = "";
            if ((toolName === "bash" || toolName === "shell") && /^task\s+/i.test(command)) {
                missReason = "raw_shell";
                await recordRoutingMiss(ctx, sessionID, missReason, 2);
            }
            else if (textOutput.includes('Task "') && textOutput.includes("does not exist") && textOutput.includes("Did you mean")) {
                missReason = "task_typo";
                await recordRoutingMiss(ctx, sessionID, missReason, 2);
            }
            else {
                const recent = state.recentTools || [];
                const hasTaskIntent = TASK_INTENT_KEYWORDS.some((keyword) => command.toLowerCase().includes(keyword));
                const allRecentNonTaskTools = recent.length >= 2 && recent.every((name) => !TASK_TOOL_NAMES.has(name));
                if (allRecentNonTaskTools && hasTaskIntent) {
                    missReason = "discovery_drift";
                    await recordRoutingMiss(ctx, sessionID, missReason, 1);
                }
            }
            if (missReason === "raw_shell") {
                await maybeSendRoutingReinforcement(ctx, sessionID, "raw shell task command", "task_run", "task_run task=\"django:lint\"");
            }
            else if (missReason === "task_typo") {
                await maybeSendRoutingReinforcement(ctx, sessionID, "task name typo", "task_help", "task_help task=\"verify:all\"");
            }
            else if (missReason === "discovery_drift") {
                await maybeSendRoutingReinforcement(ctx, sessionID, "discovery drift", "task_recommend", "task_recommend intent=\"run tests\"");
            }
        }
    };
};
export const __cleatInternals = {
    parseSlashCommand,
    detectAutomationContext,
    detectProjectSkills,
    parseMakefileDetails,
    classifyMakeTarget,
    inferCanonicalTaskName,
    buildNamespaceSuggestion,
    scoreMigrationConfidence,
    buildProposedSurface,
    buildMappingFromClassifications,
    buildPlanFromArtifacts,
    buildPolicyScore,
    buildCleatPrompt,
    buildCleatArtifactsForCommand,
    buildMigrationPolicy,
    getAlwaysLoadedSkills,
    hasSeparateTaskSummary,
    parseTaskfileYaml,
    loadTaskfile,
};
