export interface SessionInfo {
  path: string
  sessionId: string
  lastModifiedAt: string
  sizeBytes: number
}

export interface ProjectGroup {
  project: string
  displayPath: string
  sessions: SessionInfo[]
}

export interface SessionsResponse {
  homeDir: string
  projects: ProjectGroup[]
}

export interface SearchRequest {
  query: string
  userOnly?: boolean
  assistantOnly?: boolean
  startTime?: string
  endTime?: string
}

export interface SearchMatch {
  path: string
  sessionId: string
  summary: string | null
  lineNumber: number
}

export interface SearchResponse {
  results: SearchMatch[]
  totalMatches: number
  sessionsSearched: number
}

export interface ToolResultData {
  text: string
  isError: boolean
}

export interface ContentBlock {
  type: string
  text?: string
  thinking?: string       // thinking blocks
  name?: string
  input?: unknown
  id?: string             // tool_use blocks
  tool_use_id?: string    // tool_result blocks
  is_error?: boolean      // tool_result blocks
  content?: string | Array<{ type: string; text?: string }>  // tool_result blocks
}

export interface ParsedSessionLine {
  lineNumber: number
  raw: string
  parsed: {
    type?: string
    message?: {
      content?: string | ContentBlock[]
    }
    timestamp?: string
    summary?: string
    cwd?: string
    subtype?: string
    [key: string]: unknown
  } | null
}
