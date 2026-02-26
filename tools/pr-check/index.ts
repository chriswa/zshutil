#!/usr/bin/env bun
import { fetchOpenPRs, fetchUserPRs, fetchSinglePR, fetchUnresolvedSelfCommentCount, getCurrentUser } from "./gh";
import { analyzePR, sortPRs } from "./analyze";
import { renderOpenTable, renderMineTable, renderBlockers, printBlockerLegend } from "./display";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function parsePrUrl(input: string): number | null {
  const match = input.match(/^https?:\/\/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)\/?$/);
  return match ? parseInt(match[1], 10) : null;
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  const prNumber = command ? parsePrUrl(command) : null;

  if (prNumber !== null) {
    console.error(`Fetching PR #${prNumber}...\n`);
    const raw = await fetchSinglePR(prNumber);
    const analyzed = analyzePR(raw);
    if (raw.state === "OPEN") {
      const selfComments = await fetchUnresolvedSelfCommentCount(prNumber, raw.author.login);
      if (selfComments > 0) analyzed.blockers.push("Self Comment");
    }
    renderBlockers(analyzed);
    return;
  }

  if (!command || !["open", "mine"].includes(command)) {
    console.log("Usage: pr-check <open|mine|PR_URL>");
    console.log("");
    console.log("Commands:");
    console.log("  open            Show open PRs with auto-merge label");
    console.log("  mine [user]     Show PRs for a user (default: current gh user)");
    console.log("  <PR URL>        Show blockers for a specific PR");
    process.exit(1);
  }

  if (command === "open") {
    console.log("Fetching open PRs...\n");
    const rawPRs = await fetchOpenPRs();
    const analyzed = rawPRs.filter((pr) => !pr.isDraft).map(analyzePR);
    const sorted = sortPRs(analyzed);
    renderOpenTable(sorted.slice(0, 40));
  } else {
    const userArg = args.find((a) => a !== "mine" && !a.startsWith("--"));
    const user = userArg || await getCurrentUser();
    console.log(`Fetching PRs for ${user}...\n`);
    const rawPRs = await fetchUserPRs(user);
    const cutoff = Date.now() - SEVEN_DAYS_MS;
    const filtered = rawPRs.filter((pr) =>
      pr.state === "OPEN" || new Date(pr.updatedAt).getTime() > cutoff
    );
    const analyzed = filtered.map(analyzePR);
    const sorted = sortPRs(analyzed);
    renderMineTable(sorted.slice(0, 40));
  }

  printBlockerLegend();
}

main().catch((err) => {
  console.error("Error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
