import type { AnalyzedPR } from "./types";
import { resolveFailedTests } from "./circleci";

// ---- ANSI ----
const RESET = "\x1b[0m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const MAGENTA = "\x1b[35m";
const BLUE = "\x1b[34m";
const DARK_GRAY = "\x1b[90m";

function stripAnsi(str: string): string {
  return str.replace(/\x1b(?:\[[0-9;]*m|\]8;;[^\x1b]*\x1b\\)/g, "");
}

function link(url: string, text: string): string {
  return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}

const PR_URL_BASE = "https://github.com/sparelabs/spare/pull/";

function padRight(str: string, width: number): string {
  const visible = stripAnsi(str).length;
  return str + " ".repeat(Math.max(0, width - visible));
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + "\u2026";
}

// ---- Blocker registry (single source of truth) ----

type BlockerAction = "remediate" | "halt" | "wait" | "done";

interface BlockerDef {
  name: string;
  color: string;
  group: number;
  action: BlockerAction;
  draftIgnore: boolean;
}

const BLOCKER_DEFS: BlockerDef[] = [
  // Group 0: Queue / Draft
  { name: "In Merge Queue",        color: MAGENTA,    group: 0, action: "wait",      draftIgnore: false },
  { name: "Draft",                  color: MAGENTA,    group: 0, action: "wait",      draftIgnore: true },
  // Group 1: Critical blockers
  { name: "Conflicts",              color: RED,        group: 1, action: "remediate", draftIgnore: false },
  { name: "Tests",                  color: RED,        group: 1, action: "remediate", draftIgnore: false },
  { name: "Self Comment",           color: RED,        group: 1, action: "remediate", draftIgnore: false },
  { name: "Dequeued",               color: RED,        group: 1, action: "remediate", draftIgnore: false },
  // Group 2: Team tooling
  { name: "Checklist",              color: CYAN,       group: 2, action: "halt",      draftIgnore: true },
  { name: "Linear",                 color: CYAN,       group: 2, action: "halt",      draftIgnore: false },
  { name: "Safety",                 color: CYAN,       group: 2, action: "halt",      draftIgnore: false },
  { name: "Breaking",               color: CYAN,       group: 2, action: "halt",      draftIgnore: false },
  { name: "Security",               color: CYAN,       group: 2, action: "halt",      draftIgnore: false },
  // Group 3: CI / Bots
  { name: "CodeRabbit",             color: YELLOW,     group: 3, action: "remediate", draftIgnore: false },
  { name: "Review Comments",        color: YELLOW,     group: 3, action: "remediate", draftIgnore: false },
  { name: "Meticulous",             color: YELLOW,     group: 3, action: "halt",      draftIgnore: true },
  // Group 4: Human decisions
  { name: "-1 Approval",            color: BLUE,       group: 4, action: "wait",      draftIgnore: true },
  { name: "-2 Approvals",           color: BLUE,       group: 4, action: "wait",      draftIgnore: true },
  { name: "Nutshell",               color: BLUE,       group: 4, action: "wait",      draftIgnore: true },
  { name: "-auto-merge",            color: BLUE,       group: 4, action: "halt",      draftIgnore: true },
  { name: "Changes requested",      color: BLUE,       group: 4, action: "remediate", draftIgnore: false },
  { name: "-1 Reviewer",            color: BLUE,       group: 4, action: "halt",      draftIgnore: true },
  { name: "-2 Reviewers",           color: BLUE,       group: 4, action: "halt",      draftIgnore: true },
  // Group 5: Unsettled (CI still running)
  { name: "Tests Unsettled",        color: DIM,        group: 5, action: "wait",      draftIgnore: false },
  { name: "Meticulous Unsettled",   color: DIM,        group: 5, action: "wait",      draftIgnore: true },
  { name: "Checklist Unsettled",    color: DIM,        group: 5, action: "wait",      draftIgnore: true },
  { name: "Linear Unsettled",       color: DIM,        group: 5, action: "wait",      draftIgnore: false },
  { name: "Safety Unsettled",       color: DIM,        group: 5, action: "wait",      draftIgnore: false },
  { name: "Breaking Unsettled",     color: DIM,        group: 5, action: "wait",      draftIgnore: false },
  { name: "Security Unsettled",     color: DIM,        group: 5, action: "wait",      draftIgnore: false },
  // Group 6: Terminal states
  { name: "Merged",                 color: DARK_GRAY,  group: 6, action: "done",      draftIgnore: false },
  { name: "Closed",                 color: DARK_GRAY,  group: 6, action: "done",      draftIgnore: false },
  // Group 7: Waiting
  { name: "CI Unsettled",           color: DIM,        group: 7, action: "wait",      draftIgnore: false },
  { name: "Merge Queue Pending",    color: DIM,        group: 7, action: "wait",      draftIgnore: false },
];

const BLOCKER_COLOR_MAP = new Map(BLOCKER_DEFS.map((d) => [d.name, d.color]));
const BLOCKER_ACTION_MAP = new Map(BLOCKER_DEFS.map((d) => [d.name, d.action]));

function colorBlocker(blocker: string): string {
  const color = BLOCKER_COLOR_MAP.get(blocker);
  if (color) return `${color}${blocker}${RESET}`;
  if (/^-\d+ (Approvals?|Reviewers?)$/.test(blocker)) return `${BLUE}${blocker}${RESET}`;
  return `${DIM}${blocker}${RESET}`;
}

function formatBlockers(blockers: string[]): string {
  if (blockers.length === 0) return `${DIM}none${RESET}`;
  return blockers.map(colorBlocker).join(`${DIM}, ${RESET}`);
}

// ---- Legend ----

export function printBlockerLegend(): void {
  const groups = new Map<number, string[]>();
  for (const def of BLOCKER_DEFS) {
    if (!groups.has(def.group)) groups.set(def.group, []);
    groups.get(def.group)!.push(def.name);
  }
  console.log("");
  for (const [, names] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    console.log(names.map(colorBlocker).join(`${DIM}, ${RESET}`));
  }
}

// ---- Triage (pre-computed categorization for automation consumers) ----

export interface Triage {
  isDraft: boolean;
  draftClean: boolean;
  wait: string[];
  remediate: string[];
  halt: string[];
  done: string[];
  postDraft: string[];
}

const BLOCKER_DRAFT_IGNORE_MAP = new Map(BLOCKER_DEFS.map((d) => [d.name, d.draftIgnore]));

function computeTriage(blockers: string[]): Triage {
  const isDraft = blockers.includes("Draft");
  const wait: string[] = [];
  const remediate: string[] = [];
  const halt: string[] = [];
  const done: string[] = [];
  const postDraft: string[] = [];

  for (const name of blockers) {
    const action = BLOCKER_ACTION_MAP.get(name)
      ?? (/^-\d+ Reviewers?$/.test(name) ? "halt" as const : undefined)
      ?? (/^-\d+ Approvals?$/.test(name) ? "wait" as const : undefined)
      ?? "wait" as const;

    const draftIgnore = BLOCKER_DRAFT_IGNORE_MAP.get(name)
      ?? (/^-\d+ Approvals?$/.test(name) ? true : false);

    if (isDraft && draftIgnore) {
      postDraft.push(name);
      continue;
    }

    switch (action) {
      case "done":      done.push(name); break;
      case "wait":      wait.push(name); break;
      case "remediate": remediate.push(name); break;
      case "halt":      halt.push(name); break;
    }
  }

  // -auto-merge only halts when it's the sole actionable blocker
  if (halt.includes("-auto-merge") && (remediate.length > 0 || halt.length > 1)) {
    halt.splice(halt.indexOf("-auto-merge"), 1);
  }

  const draftClean = isDraft
    && done.length === 0
    && wait.length === 0
    && remediate.length === 0
    && halt.length === 0;

  return { isDraft, draftClean, wait, remediate, halt, done, postDraft };
}

// ---- Single PR blockers ----

function formatRev(pr: AnalyzedPR): string {
  const h = pr.humanApprovalCount;
  const b = pr.botApprovalCount;
  return b > 0 ? `${h}+${b}` : `${h}`;
}

export async function renderBlockers(pr: AnalyzedPR): Promise<void> {
  const prLink = link(`${PR_URL_BASE}${pr.number}`, `#${pr.number}`);
  console.error(`${BOLD}${prLink} ${pr.title}${RESET}`);
  console.error(`${DIM}Author: ${pr.author}  State: ${pr.displayState}  Reviews: ${formatRev(pr)}${RESET}`);
  const blockers = pr.blockers.map((name) => ({
    name,
    action: BLOCKER_ACTION_MAP.get(name) ?? "wait",
  }));
  const triage = computeTriage(pr.blockers);
  const failedTestDetails = await resolveFailedTests(pr.failedTestUrls);
  console.log(JSON.stringify({ blockers, failedTestUrls: pr.failedTestUrls, failedTestDetails, meticulousUrl: pr.meticulousUrl, triage }));
}

// ---- Tables ----

interface Col {
  header: string;
  width: number | "flex";
  render: (pr: AnalyzedPR) => string;
}

const COL_PR: Col =     { header: "PR#",    width: 6,  render: (pr) => link(`${PR_URL_BASE}${pr.number}`, `#${pr.number}`) };
const COL_AUTHOR: Col = { header: "Author", width: 17, render: (pr) => truncate(pr.author, 17) };
const COL_STATE: Col =  { header: "St",     width: 6,  render: (pr) => pr.displayState };
const COL_REV: Col =    { header: "Rev",    width: 3,  render: formatRev };
const COL_STALE: Col =  { header: "T",      width: 3,  render: (pr) => pr.staleLabel };

function renderTable(prs: AnalyzedPR[], cols: Col[]): void {
  const termWidth = process.stdout.columns || 120;
  const GAP = 1;

  const fixedWidth = cols.reduce((sum, c) => sum + (c.width === "flex" ? 0 : c.width) + GAP, 0);
  const flexWidth = Math.min(55, Math.max(20, termWidth - fixedWidth - GAP - 25));

  const resolveWidth = (c: Col) => c.width === "flex" ? flexWidth : c.width;

  const hdr = cols.map((c) => padRight(c.header, resolveWidth(c))).join(" ") + " Blockers";
  console.log(`${BOLD}${hdr}${RESET}`);
  console.log("\u2500".repeat(stripAnsi(hdr).length));

  for (const pr of prs) {
    const isDone = pr.displayState === "MERGED" || pr.displayState === "CLOSED";
    const isQueued = pr.displayState === "QUEUED";
    const row = cols.map((c) => padRight(c.render(pr), resolveWidth(c))).join(" ")
      + " " + formatBlockers(pr.blockers);
    if (isDone) {
      console.log(`${DARK_GRAY}${stripAnsi(row)}${RESET}`);
    } else if (isQueued) {
      console.log(`${MAGENTA}${stripAnsi(row)}${RESET}`);
    } else {
      console.log(row);
    }
  }
}

function colTitle(width: number): Col {
  return { header: "Title", width: "flex", render: (pr) => truncate(pr.title, width) };
}

export function renderOpenTable(prs: AnalyzedPR[]): void {
  const termWidth = process.stdout.columns || 120;
  const fixedWidth = 6 + 1 + 17 + 1 + 3 + 1 + 3 + 1;
  const flexWidth = Math.min(55, Math.max(20, termWidth - fixedWidth - 1 - 25));
  renderTable(prs, [COL_PR, colTitle(flexWidth), COL_AUTHOR, COL_REV, COL_STALE]);
}

export function renderMineTable(prs: AnalyzedPR[]): void {
  const termWidth = process.stdout.columns || 120;
  const fixedWidth = 6 + 1 + 6 + 1 + 3 + 1 + 3 + 1;
  const flexWidth = Math.min(55, Math.max(20, termWidth - fixedWidth - 1 - 25));
  renderTable(prs, [COL_PR, colTitle(flexWidth), COL_STATE, COL_REV, COL_STALE]);
}
