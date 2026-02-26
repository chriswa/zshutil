import type {
  GhPullRequest,
  GhStatusCheck,
  GhCheckRun,
  GhStatusContext,
  AnalyzedPR,
  CodeRabbitState,
  MeticulousState,
  TestState,
  MergifyState,
  PrDisplayState,
} from "./types";
import { getApprovalStatus } from "./mergify";

// ---- Type guards ----

function isCheckRun(check: GhStatusCheck): check is GhCheckRun {
  return check.__typename === "CheckRun";
}

function isStatusContext(check: GhStatusCheck): check is GhStatusContext {
  return check.__typename === "StatusContext";
}

function getChecks(pr: GhPullRequest): GhStatusCheck[] {
  return pr.statusCheckRollup ?? [];
}

// ---- Stale time ----

function computeStaleMinutes(updatedAt: string): number {
  return Math.floor((Date.now() - new Date(updatedAt).getTime()) / 60000);
}

function formatStaleTime(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / 1440)}d`;
}

// ---- CodeRabbit ----

function getCodeRabbitState(pr: GhPullRequest): CodeRabbitState {
  const crReviews = pr.reviews.filter((r) => r.author.login === "coderabbitai");
  if (crReviews.length === 0) return "N/A";
  const last = crReviews[crReviews.length - 1];
  if (last.state === "DISMISSED") return "N/A";
  return last.state as CodeRabbitState;
}

// ---- Meticulous ----

function getMeticulousState(pr: GhPullRequest): MeticulousState {
  const checks = getChecks(pr);
  const met = checks.find(
    (c) => isCheckRun(c) && c.name === "Meticulous Tests (spare)"
  ) as GhCheckRun | undefined;
  if (!met) return "N/A";
  if (met.status !== "COMPLETED") return "PENDING";
  if (met.conclusion === "SUCCESS") return "PASS";
  if (met.conclusion === "FAILURE") return "FAIL";
  return "N/A";
}

// ---- CI Tests ----

function isCircleCICheck(check: GhStatusCheck): boolean {
  if (isStatusContext(check)) {
    return check.context.startsWith("ci/circleci:");
  }
  if (isCheckRun(check)) {
    return check.detailsUrl?.includes("circleci.com") ?? false;
  }
  return false;
}

function isPlaywrightApprovalGate(check: GhStatusCheck): boolean {
  if (isStatusContext(check)) {
    return check.context.includes("approve_") && check.context.includes("playwright");
  }
  if (isCheckRun(check)) {
    return check.name.startsWith("playwright_e2e_run");
  }
  return false;
}

interface TestResult {
  state: TestState;
  failedUrls: string[];
}

function getTestResult(pr: GhPullRequest): TestResult {
  const checks = getChecks(pr);
  const ciChecks = checks.filter((c) => isCircleCICheck(c) && !isPlaywrightApprovalGate(c));
  if (ciChecks.length === 0) return { state: "N/A", failedUrls: [] };

  let hasFail = false;
  let hasPending = false;
  const failedUrls: string[] = [];

  for (const check of ciChecks) {
    if (isStatusContext(check)) {
      if (check.state === "FAILURE" || check.state === "ERROR") {
        hasFail = true;
        if (check.targetUrl) failedUrls.push(check.targetUrl);
      } else if (check.state === "PENDING") {
        hasPending = true;
      }
    } else if (isCheckRun(check)) {
      if (check.conclusion === "FAILURE") {
        hasFail = true;
        if (check.detailsUrl) failedUrls.push(check.detailsUrl);
      } else if (check.status !== "COMPLETED") {
        hasPending = true;
      }
    }
  }

  if (hasFail) return { state: "FAIL", failedUrls };
  if (hasPending) return { state: "PENDING", failedUrls: [] };
  return { state: "PASS", failedUrls: [] };
}

// ---- Mergify / Queue ----

function getMergifyState(pr: GhPullRequest): MergifyState {
  const checks = getChecks(pr);
  const queueChecks = checks.filter(
    (c) => isCheckRun(c) && c.name === "Queue: Embarked in merge queue"
  ) as GhCheckRun[];

  const latest = queueChecks.length > 0
    ? queueChecks.reduce((a, b) => a.startedAt > b.startedAt ? a : b)
    : undefined;

  if (latest?.conclusion === "FAILURE") return "DEQUEUED";
  if (latest?.status === "IN_PROGRESS" && latest.conclusion === "") return "IN_PROGRESS";

  const labelNames = pr.labels.map((l) => l.name);
  if (labelNames.includes("dequeued")) return "DEQUEUED";
  if (labelNames.includes("queued")) return "QUEUED";

  return "N/A";
}

// ---- Display state ----

function getDisplayState(pr: GhPullRequest, mergify: MergifyState): PrDisplayState {
  if (pr.state === "MERGED") return "MERGED";
  if (pr.state === "CLOSED") return "CLOSED";
  if (mergify === "IN_PROGRESS" || mergify === "QUEUED") return "QUEUED";
  if (pr.isDraft) return "DRAFT";
  return "OPEN";
}

// ---- GitHub Actions check state ----

function getCheckRunState(pr: GhPullRequest, name: string): TestState {
  const checks = getChecks(pr);
  const matching = checks.filter(
    (c) => isCheckRun(c) && c.name === name
  ) as GhCheckRun[];
  if (matching.length === 0) return "N/A";
  const latest = matching.reduce((a, b) => a.startedAt > b.startedAt ? a : b);
  if (latest.status !== "COMPLETED") return "PENDING";
  if (latest.conclusion === "FAILURE") return "FAIL";
  return "PASS";
}

// ---- Blockers ----

function pushCheckRunBlockers(
  pr: GhPullRequest,
  blockers: string[],
  checkName: string,
  failLabel: string,
  unsettledLabel: string
): void {
  const state = getCheckRunState(pr, checkName);
  if (state === "FAIL") blockers.push(failLabel);
  else if (state === "PENDING") blockers.push(unsettledLabel);
}

function getBlockers(
  pr: GhPullRequest,
  meticulous: MeticulousState,
  tests: TestState,
  mergify: MergifyState
): string[] {
  // Terminal states
  if (pr.state === "MERGED") return ["Merged"];
  if (pr.state === "CLOSED") return ["Closed"];

  const blockers: string[] = [];

  if (mergify === "IN_PROGRESS" || mergify === "QUEUED") {
    return ["In Merge Queue"];
  }

  if (pr.isDraft) blockers.push("Draft");

  if (pr.mergeable === "CONFLICTING") blockers.push("Conflicts");
  if (tests === "FAIL") blockers.push("Tests");
  else if (tests === "PENDING") blockers.push("Tests Unsettled");
  else if (tests === "N/A") blockers.push("CI Unsettled");
  if (mergify === "DEQUEUED") blockers.push("Dequeued");

  pushCheckRunBlockers(pr, blockers, "verify-pr-checklist", "Checklist", "Checklist Unsettled");
  pushCheckRunBlockers(pr, blockers, "verify-associated-issue", "Linear", "Linear Unsettled");
  pushCheckRunBlockers(pr, blockers, "pr-safety-check", "Safety", "Safety Unsettled");
  pushCheckRunBlockers(pr, blockers, "check-breaking-api-changes", "Breaking", "Breaking Unsettled");
  pushCheckRunBlockers(pr, blockers, "Aikido Security: check code", "Security", "Security Unsettled");

  if (meticulous === "FAIL") blockers.push("Meticulous");
  else if (meticulous === "PENDING") blockers.push("Meticulous Unsettled");

  if (pr.reviewDecision === "CHANGES_REQUESTED") {
    const hasCodeRabbit = pr.reviews.some(
      (r) => r.author.login === "coderabbitai" && r.state === "CHANGES_REQUESTED"
    );
    const hasHuman = pr.reviews.some(
      (r) => r.author.login !== "coderabbitai" && r.author.login !== "cursor" && r.state === "CHANGES_REQUESTED"
    );
    if (hasCodeRabbit) blockers.push("CodeRabbit");
    if (hasHuman) blockers.push("Changes requested");
  }

  const approval = getApprovalStatus(pr);
  if (!approval.satisfied && approval.missing > 0) {
    blockers.push(approval.detail);
  }
  if (approval.nutshellBlocked) {
    blockers.push("Nutshell");
  }
  if (!approval.autoMergeEnabled) {
    blockers.push("-auto-merge");
  }

  if (!pr.isDraft) {
    const BOTS = new Set(["coderabbitai", "cursor"]);
    const engaged = new Set<string>();
    for (const req of pr.reviewRequests) {
      if (req.__typename === "User" && !BOTS.has(req.login)) engaged.add(req.login);
    }
    for (const rev of pr.reviews) {
      if (!BOTS.has(rev.author.login)) engaged.add(rev.author.login);
    }
    const missing = Math.max(0, approval.requiredHumanReviewers - engaged.size);
    if (missing > 0) {
      blockers.push(`-${missing} Reviewer${missing > 1 ? "s" : ""}`);
    }
  }

  // Fallback: OPEN PR with everything green, waiting for Mergify to queue
  if (blockers.length === 0) {
    blockers.push("Merge Queue Pending");
  }

  return blockers;
}

// ---- Main analyze ----

export function analyzePR(pr: GhPullRequest): AnalyzedPR {
  const staleMinutes = computeStaleMinutes(pr.updatedAt);
  const codeRabbit = getCodeRabbitState(pr);
  const meticulous = getMeticulousState(pr);
  const testResult = getTestResult(pr);
  const mergify = getMergifyState(pr);
  const approval = getApprovalStatus(pr);
  const blockers = getBlockers(pr, meticulous, testResult.state, mergify);

  return {
    number: pr.number,
    title: pr.title,
    author: pr.author.login,
    displayState: getDisplayState(pr, mergify),
    staleMinutes,
    staleLabel: formatStaleTime(staleMinutes),
    codeRabbit,
    meticulous,
    tests: testResult.state,
    mergify,
    approvalCount: approval.approvalCount,
    humanApprovalCount: approval.humanApprovalCount,
    botApprovalCount: approval.botApprovalCount,
    blockers,
    failedTestUrls: testResult.failedUrls,
    labels: pr.labels.map((l) => l.name),
    updatedAt: pr.updatedAt,
  };
}

// ---- Sorting ----

const STATE_ORDER: Record<PrDisplayState, number> = {
  OPEN: 0,
  QUEUED: 1,
  DRAFT: 2,
  MERGED: 3,
  CLOSED: 4,
};

export function sortPRs(prs: AnalyzedPR[]): AnalyzedPR[] {
  return [...prs].sort((a, b) => {
    const sa = STATE_ORDER[a.displayState];
    const sb = STATE_ORDER[b.displayState];
    if (sa !== sb) return sa - sb;
    if (a.staleMinutes !== b.staleMinutes) return a.staleMinutes - b.staleMinutes;
    return a.number - b.number;
  });
}
