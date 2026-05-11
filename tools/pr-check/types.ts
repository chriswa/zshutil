// ---- Raw GH JSON types (what gh CLI returns) ----

export interface GhAuthor {
  id: string;
  is_bot: boolean;
  login: string;
  name: string;
}

export interface GhLabel {
  id: string;
  name: string;
  description: string;
  color: string;
}

export interface GhReview {
  id: string;
  author: { login: string };
  authorAssociation: string;
  body: string;
  submittedAt: string;
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING";
  commit: { oid: string };
}

export interface GhCheckRun {
  __typename: "CheckRun";
  name: string;
  status: string;
  conclusion: string;
  startedAt: string;
  completedAt: string;
  detailsUrl: string;
  workflowName: string;
}

export interface GhStatusContext {
  __typename: "StatusContext";
  context: string;
  state: string;
  startedAt: string;
  targetUrl: string;
}

export type GhStatusCheck = GhCheckRun | GhStatusContext;

export interface GhPullRequest {
  number: number;
  title: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  isDraft: boolean;
  mergeable: string;
  mergeStateStatus: string;
  reviewDecision: string;
  author: GhAuthor;
  baseRefName: string;
  headRefName: string;
  createdAt: string;
  updatedAt: string;
  labels: GhLabel[];
  reviews: GhReview[];
  reviewRequests: { __typename: string; login: string }[];
  statusCheckRollup: GhStatusCheck[] | null;
}

import type { FailedTestDetail } from "./circleci";

// ---- Analyzed / enriched types ----

export type CodeRabbitState = "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING" | "N/A";
export type MeticulousState = "PASS" | "FAIL" | "PENDING" | "N/A";
export type TestState = "PASS" | "FAIL" | "PENDING" | "N/A";
export type MergifyState = "QUEUED" | "IN_PROGRESS" | "DEQUEUED" | "N/A";
export type PrDisplayState = "QUEUED" | "MERGED" | "OPEN" | "DRAFT" | "CLOSED";

export interface AnalyzedPR {
  number: number;
  title: string;
  author: string;
  displayState: PrDisplayState;
  staleMinutes: number;
  staleLabel: string;
  codeRabbit: CodeRabbitState;
  meticulous: MeticulousState;
  tests: TestState;
  mergify: MergifyState;
  approvalCount: number;
  humanApprovalCount: number;
  botApprovalCount: number;
  blockers: string[];
  failedTestUrls: string[];
  failedTestDetails: FailedTestDetail[];
  meticulousUrl: string | null;
  labels: string[];
  updatedAt: string;
}
