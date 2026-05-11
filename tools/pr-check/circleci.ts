export interface FailedTestDetail {
  jobName: string;
  failedStep: string;
  output: string;
}

const MAX_OUTPUT_LINES = 80;
const FETCH_TIMEOUT_MS = 10_000;

function getToken(): string | undefined {
  return process.env.CIRCLECI_TOKEN;
}

async function fetchJson(url: string, token: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { "Circle-Token": token },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Extract job number from a v1-style CircleCI URL.
 * e.g. https://circleci.com/gh/sparelabs/spare/12366667
 */
function parseJobNumber(url: string): number | null {
  const match = url.match(/circleci\.com\/gh\/[^/]+\/[^/]+\/(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Extract workflow ID from a v2-style CircleCI URL.
 * e.g. https://app.circleci.com/pipelines/github/sparelabs/spare/370026/workflows/d23d0ea6-...
 */
function parseWorkflowId(url: string): string | null {
  const match = url.match(/\/workflows\/([0-9a-f-]+)/);
  return match ? match[1] : null;
}

interface V1Step {
  actions: Array<{
    name: string;
    status: string;
    output_url?: string;
  }>;
}

interface V1Job {
  workflows?: { job_name?: string };
  steps?: V1Step[];
}

interface OutputEntry {
  message: string;
}

async function fetchStepOutput(outputUrl: string): Promise<string> {
  const raw = await fetchText(outputUrl);
  if (!raw) return "";
  try {
    const entries = JSON.parse(raw) as OutputEntry[];
    const fullText = entries.map((entry) => entry.message).join("");
    const lines = fullText.split("\n");
    return lines.slice(-MAX_OUTPUT_LINES).join("\n").trim();
  } catch {
    // Output wasn't JSON (plain text fallback)
    const lines = raw.split("\n");
    return lines.slice(-MAX_OUTPUT_LINES).join("\n").trim();
  }
}

async function resolveJobNumber(jobNumber: number, token: string): Promise<FailedTestDetail[]> {
  const data = await fetchJson(
    `https://circleci.com/api/v1.1/project/github/sparelabs/spare/${jobNumber}?circle-token=${token}`,
    token,
  ) as V1Job | null;
  if (!data?.steps) return [];

  const jobName = data.workflows?.job_name ?? `job-${jobNumber}`;
  const results: FailedTestDetail[] = [];

  for (const step of data.steps) {
    for (const action of step.actions) {
      if (action.status !== "failed") continue;
      const output = action.output_url ? await fetchStepOutput(action.output_url) : "";
      results.push({ jobName, failedStep: action.name, output });
    }
  }

  return results;
}

interface V2Job {
  job_number: number;
  name: string;
  status: string;
}

interface V2JobsResponse {
  items?: V2Job[];
}

async function resolveWorkflowId(workflowId: string, token: string): Promise<FailedTestDetail[]> {
  const data = await fetchJson(
    `https://circleci.com/api/v2/workflow/${workflowId}/job`,
    token,
  ) as V2JobsResponse | null;
  if (!data?.items) return [];

  const failedJobs = data.items.filter((job) => job.status === "failed");
  const results: FailedTestDetail[] = [];
  for (const job of failedJobs) {
    const details = await resolveJobNumber(job.job_number, token);
    results.push(...details);
  }
  return results;
}

/**
 * Given the failedTestUrls from an AnalyzedPR, resolve them to actual failure details.
 * Returns an empty array if CIRCLECI_TOKEN is not set or on any API failure.
 */
export async function resolveFailedTests(failedTestUrls: string[]): Promise<FailedTestDetail[]> {
  const token = getToken();
  if (!token || failedTestUrls.length === 0) return [];

  // Deduplicate: a single failed job can appear as both a v1 URL and a v2 workflow URL.
  // Collect unique job numbers from v1 URLs, and workflow IDs from v2 URLs.
  const jobNumbers = new Set<number>();
  const workflowIds = new Set<string>();

  for (const url of failedTestUrls) {
    const jobNumber = parseJobNumber(url);
    if (jobNumber !== null) {
      jobNumbers.add(jobNumber);
      continue;
    }
    const workflowId = parseWorkflowId(url);
    if (workflowId !== null) {
      workflowIds.add(workflowId);
    }
  }

  const results: FailedTestDetail[] = [];

  // Resolve v1 job numbers directly (faster, one fewer API call)
  const jobPromises = [...jobNumbers].map(async (jobNumber) => {
    const details = await resolveJobNumber(jobNumber, token);
    results.push(...details);
  });

  // Resolve v2 workflow IDs (need to list jobs first)
  const workflowPromises = [...workflowIds].map(async (workflowId) => {
    const details = await resolveWorkflowId(workflowId, token);
    results.push(...details);
  });

  await Promise.all([...jobPromises, ...workflowPromises]);

  // Deduplicate by jobName (same job can appear via both URL patterns)
  const seen = new Set<string>();
  return results.filter((detail) => {
    const key = `${detail.jobName}:${detail.failedStep}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
