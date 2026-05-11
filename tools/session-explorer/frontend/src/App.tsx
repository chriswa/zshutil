import { useState, useEffect, useCallback } from 'react'
import { useSessionList } from './hooks/useSessionList'
import { useSearch } from './hooks/useSearch'
import { Sidebar } from './components/Sidebar'
import { SessionViewer } from './components/SessionViewer'

function buildUrl(path: string | null, line: number | null, timestamp: string | null): string {
  const url = new URL(window.location.href)
  url.search = ''
  if (path) {
    url.searchParams.set('file', path)
    if (line) url.searchParams.set('line', String(line))
    if (timestamp) url.searchParams.set('t', timestamp)
  }
  return url.toString()
}

interface HistoryState {
  file: string | null
  line: number | null
  timestamp: string | null
}

function pushBrowserUrl(path: string | null, line: number | null, timestamp: string | null) {
  const state: HistoryState = { file: path, line, timestamp }
  window.history.pushState(state, '', buildUrl(path, line, timestamp))
}

export function App() {
  const { projects, homeDir, loading: projectsLoading } = useSessionList()
  const { results, loading: searchLoading, stats, search, clearSearch } = useSearch()
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [highlightLine, setHighlightLine] = useState<number | null>(null)
  const [highlightTimestamp, setHighlightTimestamp] = useState<string | null>(null)
  const [highlightKey, setHighlightKey] = useState(0)
  const [sidebarCollapsed] = useState(false)

  // Deep-link: read ?file=...&line=...&t=... from URL on mount
  // Replace current history entry with state so back/forward works from the initial page
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const file = params.get('file')
    const line = params.get('line')
    const t = params.get('t')
    const lineNum = line ? parseInt(line, 10) : null
    const state: HistoryState = { file, line: lineNum, timestamp: t }
    window.history.replaceState(state, '', window.location.href)
    if (file) {
      setSelectedPath(file)
      if (lineNum) setHighlightLine(lineNum)
      else if (t) setHighlightTimestamp(t)
    }
  }, [])

  // Restore state on back/forward navigation
  useEffect(() => {
    function onPopState(e: PopStateEvent) {
      const state = e.state as HistoryState | null
      setSelectedPath(state?.file ?? null)
      setHighlightLine(state?.line ?? null)
      setHighlightTimestamp(state?.timestamp ?? null)
      setHighlightKey(k => k + 1)
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  function handleSelect(path: string, lineNumber?: number) {
    setSelectedPath(path)
    setHighlightLine(lineNumber ?? null)
    setHighlightTimestamp(null)
    pushBrowserUrl(path, lineNumber ?? null, null)
  }

  const handleNavigate = useCallback((path: string, timestamp?: string) => {
    setSelectedPath(path)
    setHighlightLine(null)
    setHighlightTimestamp(timestamp ?? null)
    pushBrowserUrl(path, null, timestamp ?? null)
  }, [])

  function handleNavigateToSession(sessionId: string) {
    for (const group of projects) {
      const session = group.sessions.find(s => s.sessionId === sessionId)
      if (session) {
        handleSelect(session.path)
        return
      }
    }
  }

  const handleFocusLine = useCallback((lineNumber: number) => {
    setHighlightLine(lineNumber)
    setHighlightTimestamp(null)
    setHighlightKey(k => k + 1)
    if (selectedPath) pushBrowserUrl(selectedPath, lineNumber, null)
  }, [selectedPath])

  return (
    <div className="app">
      <div className={`sidebar${sidebarCollapsed ? ' collapsed' : ''}`}>
        <Sidebar
          projects={projects}
          projectsLoading={projectsLoading}
          searchResults={results}
          searchLoading={searchLoading}
          searchStats={stats}
          selectedPath={selectedPath}
          onSelect={handleSelect}
          onSearch={search}
          onClearSearch={clearSearch}
          onNavigateToSession={handleNavigateToSession}
        />
      </div>

      <SessionViewer
        path={selectedPath}
        highlightLine={highlightLine}
        highlightTimestamp={highlightTimestamp}
        highlightKey={highlightKey}
        onNavigate={handleNavigate}
        onFocusLine={handleFocusLine}
        homeDir={homeDir}
      />
    </div>
  )
}
