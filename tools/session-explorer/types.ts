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
