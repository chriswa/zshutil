import type { GhPullRequest } from "./types";

export interface ApprovalStatus {
  satisfied: boolean;
  missing: number;
  detail: string;
  nutshellBlocked: boolean;
  autoMergeEnabled: boolean;
  approvalCount: number;
  humanApprovalCount: number;
  botApprovalCount: number;
  requiredHumanReviewers: number;
}

const NUTSHELL_APPROVERS = ["stef-spare", "mentosfreshmaker"];

export function getApprovalStatus(pr: GhPullRequest): ApprovalStatus {
  const labels = new Set(pr.labels.map((l) => l.name));
  const autoMergeEnabled = labels.has("auto-merge");
  const isMultipleReviewers = labels.has("multiple-reviewers");
  const hasAutoMergeWithAI = labels.has("auto-merge-with-ai");
  const isNutshell = labels.has("nutshell");

  const latestByReviewer = new Map<string, string>();
  for (const review of pr.reviews) {
    const login = review.author.login;
    if (review.state === "APPROVED" || review.state === "CHANGES_REQUESTED") {
      latestByReviewer.set(login, review.state);
    }
  }

  const approvedBy = new Set<string>();
  for (const [login, state] of latestByReviewer) {
    if (state === "APPROVED") approvedBy.add(login);
  }

  const crApproved = approvedBy.has("coderabbitai");
  const humanApprovals = [...approvedBy].filter((l) => l !== "coderabbitai" && l !== "cursor");
  const totalApprovals = approvedBy.size;

  let missing: number;
  let detail: string;

  if (isMultipleReviewers) {
    const pathA = Math.max(0, 2 - humanApprovals.length);
    const pathB = Math.max(0, 3 - totalApprovals);
    missing = Math.min(pathA, pathB);

    if (missing === 0) {
      detail = "Approved";
    } else if (pathA <= pathB) {
      detail = `-${pathA} Approval${pathA > 1 ? "s" : ""}`;
    } else {
      detail = `-${pathB} Approval${pathB > 1 ? "s" : ""}`;
    }
  } else {
    const pathA = Math.max(0, 1 - humanApprovals.length);
    const pathB = hasAutoMergeWithAI && crApproved ? 0 : Infinity;
    const pathC = Math.max(0, 2 - totalApprovals);
    missing = Math.min(pathA, pathB, pathC);

    if (missing === 0) {
      detail = "Approved";
    } else if (pathA <= pathC) {
      detail = `-${pathA} Approval${pathA > 1 ? "s" : ""}`;
    } else {
      detail = `-${pathC} Approval${pathC > 1 ? "s" : ""}`;
    }
  }

  // How many distinct human reviewers are needed to satisfy approval
  let requiredHumanReviewers: number;
  if (isMultipleReviewers) {
    requiredHumanReviewers = 2;
  } else if (hasAutoMergeWithAI && crApproved) {
    requiredHumanReviewers = 0;
  } else {
    requiredHumanReviewers = 1;
  }

  let nutshellBlocked = false;
  if (isNutshell) {
    const nutshellApproved = NUTSHELL_APPROVERS.some((n) => approvedBy.has(n));
    const authorIsNutshell = NUTSHELL_APPROVERS.includes(pr.author.login);
    const authorBypass = authorIsNutshell && hasAutoMergeWithAI;
    nutshellBlocked = !nutshellApproved && !authorBypass;
  }

  return {
    satisfied: missing === 0 && !nutshellBlocked,
    missing,
    detail,
    nutshellBlocked,
    autoMergeEnabled,
    approvalCount: totalApprovals,
    humanApprovalCount: humanApprovals.length,
    botApprovalCount: totalApprovals - humanApprovals.length,
    requiredHumanReviewers,
  };
}
