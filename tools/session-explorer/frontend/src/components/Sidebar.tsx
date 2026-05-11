import { useCallback, useState } from 'react'
import type { ProjectGroup, SearchMatch, SearchRequest } from '../types'
import { SearchControls, type DateRange } from './SearchControls'
import { SessionList } from './SessionList'

interface Props {
  projects: ProjectGroup[]
  projectsLoading: boolean
  searchResults: SearchMatch[] | null
  searchLoading: boolean
  searchStats: { totalMatches: number; sessionsSearched: number } | null
  selectedPath: string | null
  onSelect: (path: string, lineNumber?: number) => void
  onSearch: (req: SearchRequest) => void
  onClearSearch: () => void
  onNavigateToSession: (sessionId: string) => void
}

export function Sidebar({
  projects,
  projectsLoading,
  searchResults,
  searchLoading,
  searchStats,
  selectedPath,
  onSelect,
  onSearch,
  onClearSearch,
  onNavigateToSession,
}: Props) {
  const [groupByFolder, setGroupByFolder] = useState(true)
  const [dateFilter, setDateFilter] = useState<DateRange>({})
  const handleDateFilterChange = useCallback((range: DateRange) => setDateFilter(range), [])

  return (
    <>
      <SearchControls
        onSearch={onSearch}
        onNavigateToSession={onNavigateToSession}
        onClear={onClearSearch}
        onDateFilterChange={handleDateFilterChange}
        loading={searchLoading}
        hasResults={searchResults !== null}
      />
      <label className="view-toggle">
        <input
          type="checkbox"
          checked={groupByFolder}
          onChange={(e) => setGroupByFolder(e.target.checked)}
        />
        Group by folder
      </label>
      {searchStats && searchResults !== null && (
        <div className="search-status" style={{ padding: '0 12px 8px' }}>
          {searchStats.totalMatches} matches in {searchStats.sessionsSearched} sessions searched
        </div>
      )}
      <SessionList
        projects={projects}
        searchResults={searchResults}
        selectedPath={selectedPath}
        onSelect={onSelect}
        loading={projectsLoading || searchLoading}
        groupByFolder={groupByFolder}
        dateFilter={dateFilter}
      />
    </>
  )
}
