import type { GhPullRequest } from "./types";

const REPO = "sparelabs/spare";
const JSON_FIELDS =
  "state,mergeable,mergeStateStatus,statusCheckRollup,title,headRefName,baseRefName,reviewDecision,isDraft,labels,updatedAt,createdAt,author,reviews,reviewRequests,number";
const PAGE_SIZE = 5;
const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1000;

async function run(args: string[]): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode === 0) return stdout;

    const stderr = await new Response(proc.stderr).text();
    if (attempt >= MAX_RETRIES || !isRetryable(stderr)) {
      throw new Error(`Command failed (exit ${exitCode}): ${args.join(" ")}\n${stderr}`);
    }
    const delay = INITIAL_BACKOFF_MS * 2 ** attempt;
    console.error(`gh failed (attempt ${attempt + 1}/${MAX_RETRIES + 1}), retrying in ${delay}ms...`);
    await Bun.sleep(delay);
  }
}

function isRetryable(stderr: string): boolean {
  return /GraphQL|rate limit|timeout|ETIMEDOUT|ECONNRESET|502|503|504/i.test(stderr);
}

interface ListOptions {
  state: string;
  limit?: number;
  labels?: string[];
  author?: string;
}

async function listPRs(opts: ListOptions): Promise<GhPullRequest[]> {
  const { state, limit = 100, labels, author } = opts;

  const numberArgs = ["gh", "pr", "list", "--repo", REPO, "--state", state, "--limit", String(limit), "--json", "number"];
  if (labels) {
    for (const label of labels) {
      numberArgs.splice(numberArgs.indexOf("--json"), 0, "--label", label);
    }
  }
  if (author) {
    numberArgs.splice(numberArgs.indexOf("--json"), 0, "--author", author);
  }
  const allNumbers: { number: number }[] = JSON.parse(await run(numberArgs));

  const results: GhPullRequest[] = [];
  for (let i = 0; i < allNumbers.length; i += PAGE_SIZE) {
    const batch = allNumbers.slice(i, i + PAGE_SIZE);
    const pages = await Promise.all(
      batch.map(async ({ number }) => {
        const json = await run(["gh", "pr", "view", String(number), "--repo", REPO, "--json", JSON_FIELDS]);
        return JSON.parse(json) as GhPullRequest;
      }),
    );
    results.push(...pages);
  }
  return results;
}

export async function getCurrentUser(): Promise<string> {
  return (await run(["gh", "api", "user", "--jq", ".login"])).trim();
}

export async function fetchSinglePR(number: number): Promise<GhPullRequest> {
  const json = await run(["gh", "pr", "view", String(number), "--repo", REPO, "--json", JSON_FIELDS]);
  return JSON.parse(json) as GhPullRequest;
}

const REVIEW_THREADS_QUERY = `
  query($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        reviewThreads(first: 100) {
          nodes {
            isResolved
            comments(first: 1) {
              nodes { author { login } }
            }
          }
        }
      }
    }
  }
`;

export async function fetchUnresolvedSelfCommentCount(prNumber: number, author: string): Promise<number> {
  const [owner, repo] = REPO.split("/");
  const result = await run([
    "gh", "api", "graphql",
    "-F", `owner=${owner}`,
    "-F", `repo=${repo}`,
    "-F", `number=${prNumber}`,
    "-f", `query=${REVIEW_THREADS_QUERY}`,
  ]);
  const threads = JSON.parse(result).data.repository.pullRequest.reviewThreads.nodes as {
    isResolved: boolean;
    comments: { nodes: { author: { login: string } }[] };
  }[];
  return threads.filter((t) =>
    !t.isResolved && t.comments.nodes[0]?.author?.login === author
  ).length;
}

export async function fetchOpenPRs(): Promise<GhPullRequest[]> {
  return listPRs({ state: "open", labels: ["auto-merge"] });
}

export async function fetchUserPRs(user: string): Promise<GhPullRequest[]> {
  const [open, closed, merged] = await Promise.all([
    listPRs({ state: "open", author: user, limit: 50 }),
    listPRs({ state: "closed", author: user, limit: 10 }),
    listPRs({ state: "merged", author: user, limit: 10 }),
  ]);
  const seen = new Set<number>();
  const prs: GhPullRequest[] = [];
  for (const pr of [...open, ...closed, ...merged]) {
    if (!seen.has(pr.number)) {
      seen.add(pr.number);
      prs.push(pr);
    }
  }
  return prs;
}
