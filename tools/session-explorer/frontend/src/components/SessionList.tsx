import { useMemo, useEffect, useRef } from 'react'
import type { ProjectGroup, SearchMatch, SessionInfo } from '../types'
import type { DateRange } from './SearchControls'

function filterSessionsByDate(sessions: SessionInfo[], dateFilter: DateRange): SessionInfo[] {
  if (!dateFilter.startTime && !dateFilter.endTime) return sessions
  return sessions.filter((s) => {
    if (dateFilter.startTime && s.lastModifiedAt < dateFilter.startTime) return false
    if (dateFilter.endTime && s.lastModifiedAt > dateFilter.endTime) return false
    return true
  })
}

function formatRelativeDate(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime()
  const minutes = Math.floor(diffMs / 60_000)
  if (minutes < 60) return minutes === 1 ? '1 minute ago' : `${minutes} minutes ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return hours === 1 ? '1 hour ago' : `${hours} hours ago`
  const days = Math.floor(hours / 24)
  return days === 1 ? '1 day ago' : `${days} days ago`
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

interface BrowseProps {
  projects: ProjectGroup[]
  selectedPath: string | null
  onSelect: (path: string, lineNumber?: number) => void
}

function BrowseList({ projects, selectedPath, onSelect }: BrowseProps) {
  const activeRef = useRef<HTMLDivElement>(null)
  const scrolledRef = useRef(false)

  useEffect(() => {
    if (activeRef.current && !scrolledRef.current) {
      scrolledRef.current = true
      activeRef.current.scrollIntoView({ block: 'center' })
    }
  })

  if (projects.length === 0) {
    return <div style={{ padding: 12, color: 'var(--text-dim)' }}>No sessions found</div>
  }

  const hasSelected = selectedPath && projects.some(g => g.sessions.some(s => s.path === selectedPath))

  return (
    <>
      {projects.map((group) => {
        const containsSelected = hasSelected && group.sessions.some(s => s.path === selectedPath)
        return (
          <details key={group.project} open={containsSelected || undefined}>
            <summary>
              {group.displayPath}
              <span style={{ color: 'var(--text-dim)', fontWeight: 400, marginLeft: 8 }}>
                ({group.sessions.length})
              </span>
            </summary>
            {group.sessions.map((session) => {
              const isActive = session.path === selectedPath
              return (
                <div
                  key={session.path}
                  ref={isActive ? activeRef : undefined}
                  className={`session-item${isActive ? ' active' : ''}`}
                  onClick={() => onSelect(session.path)}
                >
                  <span className="session-item-id">{session.sessionId}</span>
                  <span className="session-item-meta">
                    <span>{formatRelativeDate(session.lastModifiedAt)}</span>
                    <span>{formatSize(session.sizeBytes)}</span>
                  </span>
                </div>
              )
            })}
          </details>
        )
      })}
    </>
  )
}

interface FlatItem {
  session: SessionInfo
  displayPath: string
}

interface FlatProps {
  projects: ProjectGroup[]
  selectedPath: string | null
  onSelect: (path: string, lineNumber?: number) => void
}

function FlatList({ projects, selectedPath, onSelect }: FlatProps) {
  const activeRef = useRef<HTMLDivElement>(null)
  const scrolledRef = useRef(false)

  const items = useMemo<FlatItem[]>(() => {
    const flat: FlatItem[] = []
    for (const group of projects) {
      for (const session of group.sessions) {
        flat.push({ session, displayPath: group.displayPath })
      }
    }
    return flat.sort((a, b) => b.session.lastModifiedAt.localeCompare(a.session.lastModifiedAt))
  }, [projects])

  useEffect(() => {
    if (activeRef.current && !scrolledRef.current) {
      scrolledRef.current = true
      activeRef.current.scrollIntoView({ block: 'center' })
    }
  })

  if (items.length === 0) {
    return <div style={{ padding: 12, color: 'var(--text-dim)' }}>No sessions found</div>
  }

  return (
    <>
      {items.map(({ session, displayPath }) => {
        const isActive = session.path === selectedPath
        return (
          <div
            key={session.path}
            ref={isActive ? activeRef : undefined}
            className={`session-item${isActive ? ' active' : ''}`}
            onClick={() => onSelect(session.path)}
          >
            <span className="session-item-id">{session.sessionId}</span>
            <span className="session-item-meta">
              <span>{formatRelativeDate(session.lastModifiedAt)}</span>
              <span>{formatSize(session.sizeBytes)}</span>
            </span>
            <span className="session-item-folder">{displayPath}</span>
          </div>
        )
      })}
    </>
  )
}

interface SearchProps {
  results: SearchMatch[]
  selectedPath: string | null
  onSelect: (path: string, lineNumber?: number) => void
}

function SearchList({ results, selectedPath, onSelect }: SearchProps) {
  if (results.length === 0) {
    return <div style={{ padding: 12, color: 'var(--text-dim)' }}>No matches found</div>
  }

  return (
    <>
      {results.map((match, i) => (
        <div
          key={`${match.path}-${match.lineNumber}-${i}`}
          className={`search-match-item${match.path === selectedPath ? ' active' : ''}`}
          onClick={() => onSelect(match.path, match.lineNumber)}
        >
          <div className="search-match-summary">
            {match.summary ?? match.sessionId}
          </div>
          <div className="search-match-detail">
            Line {match.lineNumber} &middot; {match.path}
          </div>
        </div>
      ))}
    </>
  )
}

interface Props {
  projects: ProjectGroup[]
  searchResults: SearchMatch[] | null
  selectedPath: string | null
  onSelect: (path: string, lineNumber?: number) => void
  loading: boolean
  groupByFolder: boolean
  dateFilter: DateRange
}

export function SessionList({ projects, searchResults, selectedPath, onSelect, loading, groupByFolder, dateFilter }: Props) {
  if (loading) {
    return <div style={{ padding: 12, color: 'var(--text-muted)' }}>Loading...</div>
  }

  // Apply date filter client-side when browsing (search handles its own filtering on the backend)
  const filteredProjects = useMemo(() => {
    if (searchResults !== null) return projects
    return projects
      .map((g) => ({ ...g, sessions: filterSessionsByDate(g.sessions, dateFilter) }))
      .filter((g) => g.sessions.length > 0)
  }, [projects, dateFilter, searchResults])

  let content
  if (searchResults !== null) {
    content = <SearchList results={searchResults} selectedPath={selectedPath} onSelect={onSelect} />
  } else if (groupByFolder) {
    content = <BrowseList projects={filteredProjects} selectedPath={selectedPath} onSelect={onSelect} />
  } else {
    content = <FlatList projects={filteredProjects} selectedPath={selectedPath} onSelect={onSelect} />
  }

  return <div className="session-list">{content}</div>
}
