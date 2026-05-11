import { useState } from 'react'
import type { SearchMatch, SearchRequest } from '../types'
import { searchSessions } from '../api'

export function useSearch() {
  const [results, setResults] = useState<SearchMatch[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [stats, setStats] = useState<{ totalMatches: number; sessionsSearched: number } | null>(null)

  async function search(req: SearchRequest) {
    setLoading(true)
    setError(null)
    try {
      const data = await searchSessions(req)
      setResults(data.results)
      setStats({ totalMatches: data.totalMatches, sessionsSearched: data.sessionsSearched })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed')
    } finally {
      setLoading(false)
    }
  }

  function clearSearch() {
    setResults(null)
    setStats(null)
    setError(null)
  }

  return { results, loading, error, stats, search, clearSearch }
}
