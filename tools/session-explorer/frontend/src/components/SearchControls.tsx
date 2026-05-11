import { useState, useEffect } from 'react'
import type { SearchRequest } from '../types'

export interface DateRange {
  startTime?: string
  endTime?: string
}

type DateMode = 'recency' | 'precise'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface Props {
  onSearch: (req: SearchRequest) => void
  onNavigateToSession: (sessionId: string) => void
  onClear: () => void
  onDateFilterChange: (range: DateRange) => void
  loading: boolean
  hasResults: boolean
}

export function SearchControls({ onSearch, onNavigateToSession, onClear, onDateFilterChange, loading, hasResults }: Props) {
  const [query, setQuery] = useState('')
  const [userOnly, setUserOnly] = useState(false)
  const [assistantOnly, setAssistantOnly] = useState(false)
  const [dateMode, setDateMode] = useState<DateMode>('recency')
  const [recency, setRecency] = useState('')
  const [customDays, setCustomDays] = useState('')
  const [startTime, setStartTime] = useState('')
  const [endTime, setEndTime] = useState('')

  useEffect(() => {
    onDateFilterChange(buildDateRange())
  }, [dateMode, recency, customDays, startTime, endTime])

  function buildDateRange(): DateRange {
    if (dateMode === 'recency') {
      let days: number | null = null
      if (recency === 'day') days = 1
      else if (recency === 'week') days = 7
      else if (recency === 'custom' && customDays) days = parseInt(customDays, 10)

      if (days && days > 0) {
        return { startTime: new Date(Date.now() - days * 86400000).toISOString() }
      }
    } else {
      const result: { startTime?: string; endTime?: string } = {}
      if (startTime) result.startTime = new Date(startTime).toISOString()
      if (endTime) result.endTime = new Date(endTime).toISOString()
      return result
    }
    return {}
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const trimmed = query.trim()
    if (!trimmed) return

    if (UUID_RE.test(trimmed)) {
      onNavigateToSession(trimmed)
      return
    }

    const dateRange = buildDateRange()
    onSearch({
      query: trimmed,
      userOnly: userOnly || undefined,
      assistantOnly: assistantOnly || undefined,
      ...dateRange,
    })
  }

  function handleClear() {
    setQuery('')
    onClear()
  }

  return (
    <div className="search-controls">
      <form onSubmit={handleSubmit}>
        <div className="search-input-row">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search sessions..."
          />
          {(query || hasResults) && (
            <button type="button" className="clear-btn" onClick={handleClear}>
              ✕
            </button>
          )}
          <button type="submit" disabled={loading || !query.trim()}>
            {loading ? '...' : 'Search'}
          </button>
        </div>

        <div className="search-filters">
          <label>
            <input type="checkbox" checked={userOnly} onChange={(e) => setUserOnly(e.target.checked)} />
            User messages only
          </label>
          <label>
            <input type="checkbox" checked={assistantOnly} onChange={(e) => setAssistantOnly(e.target.checked)} />
            Assistant messages only
          </label>

          <div className="date-filter">
            <div className="date-filter-header">
              <span>Date filter:</span>
              <button
                type="button"
                className="date-mode-toggle"
                onClick={() => setDateMode(dateMode === 'recency' ? 'precise' : 'recency')}
              >
                {dateMode === 'recency' ? 'precise mode' : 'recency mode'}
              </button>
            </div>

            {dateMode === 'recency' ? (
              <div className="recency-controls">
                <select value={recency} onChange={(e) => setRecency(e.target.value)}>
                  <option value="">Any time</option>
                  <option value="day">Last day</option>
                  <option value="week">Last week</option>
                  <option value="custom">Custom days</option>
                </select>
                {recency === 'custom' && (
                  <input
                    type="number"
                    min="1"
                    value={customDays}
                    onChange={(e) => setCustomDays(e.target.value)}
                    placeholder="days"
                  />
                )}
              </div>
            ) : (
              <div className="precise-controls">
                <label>
                  Start:
                  <input
                    type="datetime-local"
                    value={startTime}
                    onChange={(e) => setStartTime(e.target.value)}
                  />
                </label>
                <label>
                  End:
                  <input
                    type="datetime-local"
                    value={endTime}
                    onChange={(e) => setEndTime(e.target.value)}
                  />
                </label>
              </div>
            )}
          </div>
        </div>
      </form>
    </div>
  )
}
