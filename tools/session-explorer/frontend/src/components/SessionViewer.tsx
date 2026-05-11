import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSession } from '../hooks/useSession'
import { SessionLine } from './SessionLine'
import type { ContentBlock, ParsedSessionLine, ToolResultData } from '../types'

const HIDDEN_TYPES = new Set(['progress', 'file-history-snapshot', 'system', 'queue-operation'])
// Tool names whose use-blocks produce no visible pill when showAll is off
const PILL_HIDDEN_TOOLS = new Set(['Read', 'Grep', 'Glob'])

type LineClass = 'human' | 'tool-result' | 'tool-rejection-with-message' | 'tool-rejection-silent'

function getToolResultText(block: ContentBlock): string {
  if (typeof block.content === 'string') return block.content
  if (Array.isArray(block.content)) return block.content.map(b => b.text ?? '').join('')
  return ''
}

function classifyUserLine(line: ParsedSessionLine): LineClass {
  const content = line.parsed?.message?.content
  if (!Array.isArray(content)) return 'human'
  const first = content[0]
  if (first?.type !== 'tool_result') return 'human'
  if (!first.is_error) return 'tool-result'
  const text = getToolResultText(first)
  if (text.includes('the user said:\n')) return 'tool-rejection-with-message'
  return 'tool-rejection-silent'
}

function buildToolResultsMap(lines: ParsedSessionLine[]): Map<string, ToolResultData> {
  const map = new Map<string, ToolResultData>()
  for (const line of lines) {
    const content = line.parsed?.message?.content
    if (line.parsed?.type !== 'user' || !Array.isArray(content)) continue
    for (const block of content) {
      if (block.type !== 'tool_result' || !block.tool_use_id) continue
      map.set(block.tool_use_id, {
        text: getToolResultText(block),
        isError: block.is_error === true,
      })
    }
  }
  return map
}

function buildReactionsMap(lines: ParsedSessionLine[]): Map<string, 'approved' | 'rejected'> {
  const map = new Map<string, 'approved' | 'rejected'>()
  for (const line of lines) {
    const content = line.parsed?.message?.content
    if (line.parsed?.type !== 'user' || !Array.isArray(content)) continue
    for (const block of content) {
      if (block.type !== 'tool_result' || !block.tool_use_id) continue
      map.set(block.tool_use_id, block.is_error ? 'rejected' : 'approved')
    }
  }
  return map
}

interface SessionMeta {
  directory: string
  sessionId: string
  slug: string | null
  cwd: string | null
}

function extractSessionMeta(path: string, lines: ParsedSessionLine[]): SessionMeta {
  // Extract session ID and directory from path like ~/.../<dir>/<id>.jsonl
  const parts = path.split('/')
  const filename = parts[parts.length - 1] ?? ''
  const sessionId = filename.replace('.jsonl', '')
  const dirEncoded = parts[parts.length - 2] ?? ''

  // Decode directory: -Users-chriswaddell-spaceterm → ~/spaceterm
  // The dir name is the original absolute path with / replaced by -
  const homePrefix = '-Users-' + (dirEncoded.split('-')[2] ?? '')
  let directory = dirEncoded
  if (dirEncoded.startsWith(homePrefix + '-')) {
    directory = '~/' + dirEncoded.slice(homePrefix.length + 1)
  } else if (dirEncoded === homePrefix) {
    directory = '~'
  }

  // Extract slug and cwd from first few lines
  let slug: string | null = null
  let cwd: string | null = null
  for (let i = 0; i < Math.min(lines.length, 10); i++) {
    const p = lines[i].parsed
    if (!p) continue
    if (!slug && typeof p.slug === 'string') slug = p.slug
    if (!cwd && typeof p.cwd === 'string') cwd = p.cwd
    if (slug && cwd) break
  }

  return { directory, sessionId, slug, cwd }
}

interface ContinuationInfo {
  targetPath: string    // Display path (~/...) for navigation
  targetSessionId: string
  timestamp: string     // Local time string for display and ?t= param
}

function detectContinuation(lines: ParsedSessionLine[]): ContinuationInfo | null {
  const marker = 'read the full transcript at: '
  for (let i = 0; i < Math.min(lines.length, 10); i++) {
    const p = lines[i].parsed
    if (p?.type !== 'user' || !p.planContent) continue
    const content = p.message?.content
    const text = typeof content === 'string' ? content : ''
    const idx = text.indexOf(marker)
    if (idx === -1) continue

    const absPath = text.slice(idx + marker.length).split('\n')[0].trim()
    // Convert absolute path to display path: /Users/foo/... → ~/...
    const homeMatch = absPath.match(/^\/Users\/[^/]+\//)
    const targetPath = homeMatch ? '~/' + absPath.slice(homeMatch[0].length) : absPath

    const targetParts = absPath.split('/')
    const targetFile = targetParts[targetParts.length - 1] ?? ''
    const targetSessionId = targetFile.replace('.jsonl', '')

    // Use this event's timestamp, converted to local time
    const ts = p.timestamp
    const localTs = ts ? utcToLocalDisplay(ts) : ''

    return { targetPath, targetSessionId, timestamp: localTs }
  }
  return null
}

/** Convert UTC ISO string to local YYYY-MM-DDTHH:MM:SS for display and ?t= param */
function utcToLocalDisplay(utcIso: string): string {
  const d = new Date(utcIso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** Convert local YYYY-MM-DDTHH:MM:SS to UTC ISO string for comparison with JSONL timestamps */
function localToUtcIso(localTs: string): string {
  return new Date(localTs).toISOString()
}

/** Find the line number of the last visible line with timestamp <= targetUtc */
function resolveTimestampToLine(visibleLines: ParsedSessionLine[], targetUtc: string): number | null {
  for (let i = visibleLines.length - 1; i >= 0; i--) {
    const ts = visibleLines[i].parsed?.timestamp
    if (ts && ts <= targetUtc) return visibleLines[i].lineNumber
  }
  // All events are after target — fall back to first visible line
  return visibleLines.length > 0 ? visibleLines[0].lineNumber : null
}

interface Props {
  path: string | null
  highlightLine: number | null
  highlightTimestamp: string | null
  highlightKey: number
  onNavigate: (path: string, timestamp?: string) => void
  onFocusLine: (lineNumber: number) => void
  homeDir: string
}

export function SessionViewer({ path, highlightLine, highlightTimestamp, highlightKey, onNavigate, onFocusLine, homeDir }: Props) {
  const { lines, loading, error } = useSession(path)
  const containerRef = useRef<HTMLDivElement>(null)
  const [showAll, setShowAll] = useState(false)
  const [showThinking, setShowThinking] = useState(false)
  const [showBash, setShowBash] = useState(false)
  const [showWrites, setShowWrites] = useState(true)
  const [showTools, setShowTools] = useState(true)
  const [focused, setFocused] = useState(false)
  const programmaticScroll = useRef(false)
  const reactions = useMemo(() => buildReactionsMap(lines), [lines])
  const toolResults = useMemo(() => buildToolResultsMap(lines), [lines])
  const meta = useMemo(() => path ? extractSessionMeta(path, lines) : null, [path, lines])
  const continuation = useMemo(() => detectContinuation(lines), [lines])

  // Set focused when resolvedLine changes (from props or from onFocusLine)
  const prevResolvedLine = useRef<number | null>(null)
  const prevHighlightKey = useRef(highlightKey)

  // Scroll handler: detect manual scroll to clear focus
  const handleScroll = useCallback(() => {
    if (programmaticScroll.current) {
      programmaticScroll.current = false
      return
    }
    setFocused(false)
  }, [])

  const effectiveShowThinking = showThinking || showAll

  // Resolve highlight: ?line= takes precedence, then ?t= resolves to a line
  const visibleLines = showAll
    ? lines
    : lines.filter((line) => {
        if (HIDDEN_TYPES.has(line.parsed?.type ?? '')) return false
        if (line.parsed?.type === 'user') {
          const cls = classifyUserLine(line)
          if (cls === 'tool-result' || cls === 'tool-rejection-silent') return false
          if (cls === 'human') {
            const content = line.parsed?.message?.content
            if (typeof content === 'string' && !content.trim()) return false
            if (Array.isArray(content)) {
              const hasNonText = content.some(b => b.type !== 'text')
              const hasText = content.some(b => b.type === 'text' && b.text?.trim())
              if (!hasNonText && !hasText) return false
            }
          }
        }
        if (line.parsed?.type === 'assistant') {
          const content = line.parsed?.message?.content
          if (Array.isArray(content) && content.length > 0) {
            const hasVisible = content.some(block => {
              if (block.type === 'text' && block.text?.trim()) return true
              if (block.type === 'thinking') return effectiveShowThinking
              if (block.type === 'tool_use' && block.name) {
                if (block.name === 'ExitPlanMode') {
                  const input = block.input as Record<string, unknown> | undefined
                  return Boolean(input && typeof input.plan === 'string')
                }
                if (block.name === 'Bash') return showBash
                if (block.name === 'Write' || block.name === 'Edit' || block.name === 'Read') {
                  const input = block.input as Record<string, unknown> | undefined
                  const fp = typeof input?.file_path === 'string' ? input.file_path : ''
                  if (fp.includes('/.claude/plans/')) return false
                }
                if (block.name === 'Write' || block.name === 'Edit') return showWrites
                return showTools && !PILL_HIDDEN_TOOLS.has(block.name)
              }
              return false
            })
            if (!hasVisible) return false
          }
        }
        return true
      })

  const visibleLineNumbers = useMemo(
    () => new Set(visibleLines.map(l => l.lineNumber)),
    [visibleLines]
  )

  // Map each visible line number to the previous visible line's timestamp (for date-change detection)
  const prevTimestampMap = useMemo(() => {
    const map = new Map<number, string | undefined>()
    for (let i = 0; i < visibleLines.length; i++) {
      map.set(visibleLines[i].lineNumber, i > 0 ? visibleLines[i - 1].parsed?.timestamp : undefined)
    }
    return map
  }, [visibleLines])

  const resolvedLine = useMemo(() => {
    if (highlightLine) return highlightLine
    if (highlightTimestamp && visibleLines.length > 0) {
      const targetUtc = localToUtcIso(highlightTimestamp)
      return resolveTimestampToLine(visibleLines, targetUtc)
    }
    return null
  }, [highlightLine, highlightTimestamp, visibleLines])

  // Track when resolvedLine or highlightKey changes to set focused
  useEffect(() => {
    if (resolvedLine && (resolvedLine !== prevResolvedLine.current || highlightKey !== prevHighlightKey.current)) {
      setFocused(true)
    }
    prevResolvedLine.current = resolvedLine
    prevHighlightKey.current = highlightKey
  }, [resolvedLine, highlightKey])

  // Scroll to focused line, re-centering on filter changes via visibleLines dep
  useEffect(() => {
    if (!focused || !resolvedLine || !containerRef.current) return
    programmaticScroll.current = true
    let targetLine = resolvedLine
    if (!visibleLines.some(l => l.lineNumber === resolvedLine)) {
      const before = visibleLines.filter(l => l.lineNumber < resolvedLine)
      const after = visibleLines.filter(l => l.lineNumber > resolvedLine)
      targetLine = before.length > 0
        ? before[before.length - 1].lineNumber
        : after.length > 0 ? after[0].lineNumber : resolvedLine
    }
    requestAnimationFrame(() => {
      const el = containerRef.current?.querySelector(`[data-line="${targetLine}"]`)
      el?.scrollIntoView({ behavior: 'instant', block: 'center' })
    })
  }, [visibleLines, focused, resolvedLine])

  if (!path) {
    return <div className="viewer-empty">Select a session to view</div>
  }

  if (loading) {
    return <div className="viewer-loading">Loading session...</div>
  }

  if (error) {
    return <div className="viewer-empty">Error: {error}</div>
  }

  return (
    <div className="viewer-container">
      <div className="viewer-toolbar">
        {meta && (
          <div className="session-header">
            <div className="session-header-title">
              <span className="session-header-dir">{meta.directory}</span>
              {' '}
              <span className="session-header-slug">{meta.slug ?? meta.sessionId.slice(0, 8)}</span>
              {meta.slug && (
                <span className="session-header-id"> ({meta.sessionId.slice(0, 8)})</span>
              )}
            </div>
            {continuation && (
              <div className="session-header-continuation">
                Continued from:{' '}
                <a
                  className="continuation-link"
                  onClick={() => onNavigate(continuation.targetPath, continuation.timestamp)}
                >
                  {continuation.targetSessionId.slice(0, 8)}
                  {continuation.timestamp && ` @ ${continuation.timestamp.replace('T', ' ')}`}
                </a>
              </div>
            )}
          </div>
        )}
        <div className="viewer-toolbar-filters">
          <label>
            <input type="checkbox" checked={showThinking || showAll} disabled={showAll} onChange={(e) => setShowThinking(e.target.checked)} />
            Thinking
          </label>
          <label>
            <input type="checkbox" checked={showBash || showAll} disabled={showAll} onChange={(e) => setShowBash(e.target.checked)} />
            Bash
          </label>
          <label>
            <input type="checkbox" checked={showWrites || showAll} disabled={showAll} onChange={(e) => setShowWrites(e.target.checked)} />
            Writes
          </label>
          <label>
            <input type="checkbox" checked={showTools || showAll} disabled={showAll} onChange={(e) => setShowTools(e.target.checked)} />
            Tools
          </label>
          <label>
            <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
            Show all
          </label>
          {focused && resolvedLine && (
            <span className="focus-indicator">#{resolvedLine}</span>
          )}
        </div>
      </div>

      <div className="viewer" ref={containerRef} onScroll={handleScroll}>
        {lines.map((line) => {
          const isHighlighted = line.lineNumber === resolvedLine
          const isFiltered = !visibleLineNumbers.has(line.lineNumber)
          const prevTs = prevTimestampMap.get(line.lineNumber)
          return (
            <div
              key={isHighlighted ? `${line.lineNumber}-${highlightKey}` : line.lineNumber}
              className={`line-wrapper${isFiltered ? ' filtered-out' : ''}`}
              data-line={line.lineNumber}
            >
              <div className="line-wrapper-inner">
                <SessionLine line={line} highlighted={isHighlighted} sessionPath={path} reactions={reactions} toolResults={toolResults} showAll={showAll} showThinking={showThinking || showAll} showBash={showBash || showAll} showWrites={showWrites || showAll} showTools={showTools || showAll} homeDir={homeDir} onFocusLine={onFocusLine} prevTimestamp={prevTs} />
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
