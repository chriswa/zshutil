import type { SessionsResponse, SearchRequest, SearchResponse } from './types'

export async function fetchSessions(): Promise<SessionsResponse> {
  const res = await fetch('/api/sessions')
  if (!res.ok) throw new Error(`Failed to fetch sessions: ${res.status}`)
  return res.json()
}

export async function fetchSession(path: string): Promise<string> {
  const res = await fetch(`/api/session?path=${encodeURIComponent(path)}`)
  if (!res.ok) throw new Error(`Failed to fetch session: ${res.status}`)
  return res.text()
}

export async function searchSessions(req: SearchRequest): Promise<SearchResponse> {
  const res = await fetch('/api/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  })
  if (!res.ok) throw new Error(`Search failed: ${res.status}`)
  return res.json()
}
