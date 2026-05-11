import { useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ParsedSessionLine, ToolResultData } from '../types'

function getTypeBadgeClass(type: string | undefined): string {
  switch (type) {
    case 'user': return 'user'
    case 'assistant': return 'assistant'
    case 'summary': return 'summary'
    case 'system': return 'system'
    case 'progress': return 'progress'
    default: return 'other'
  }
}

interface ToolUseInfo {
  name: string
  id: string
}

interface ToolSection {
  toolName: string
  id: string
  summary: string
  detail: string
  defaultOpen: boolean
}

interface DisplayContent {
  text: string
  toolUses: ToolUseInfo[]
  toolSections: ToolSection[]
  thinkingText: string | null
  planText: string | null
}

function formatEditDiff(input: Record<string, unknown>): string {
  const filePath = String(input.file_path ?? '')
  const oldStr = String(input.old_string ?? '')
  const newStr = String(input.new_string ?? '')
  const lines: string[] = [`--- ${filePath}`, `+++ ${filePath}`]
  for (const line of oldStr.split('\n')) {
    lines.push(`- ${line}`)
  }
  for (const line of newStr.split('\n')) {
    lines.push(`+ ${line}`)
  }
  return lines.join('\n')
}

function buildToolSection(name: string, id: string, input: Record<string, unknown>): ToolSection | null {
  switch (name) {
    case 'Read': {
      const fp = String(input.file_path ?? '')
      const parts = [fp]
      if (input.offset != null) parts.push(`offset: ${input.offset}`)
      if (input.limit != null) parts.push(`limit: ${input.limit}`)
      return { toolName: name, id, summary: fp, detail: parts.join(', '), defaultOpen: false }
    }
    case 'Write': {
      const fp = String(input.file_path ?? '')
      const content = String(input.content ?? '')
      return { toolName: name, id, summary: fp, detail: `${fp}\n${content}`, defaultOpen: false }
    }
    case 'Edit': {
      const fp = String(input.file_path ?? '')
      return { toolName: name, id, summary: fp, detail: formatEditDiff(input), defaultOpen: true }
    }
    case 'Grep': {
      const pattern = String(input.pattern ?? '')
      const path = input.path ? String(input.path) : ''
      const summary = path ? `${pattern} in ${path}` : pattern
      const parts = [`pattern: ${pattern}`]
      if (path) parts.push(`path: ${path}`)
      if (input.output_mode) parts.push(`mode: ${input.output_mode}`)
      return { toolName: name, id, summary, detail: parts.join('\n'), defaultOpen: false }
    }
    case 'Glob': {
      const pattern = String(input.pattern ?? '')
      const path = input.path ? String(input.path) : ''
      const summary = path ? `${pattern} in ${path}` : pattern
      return { toolName: name, id, summary, detail: summary, defaultOpen: false }
    }
    case 'Bash': {
      const cmd = String(input.command ?? '')
      const desc = input.description ? String(input.description) : ''
      return { toolName: name, id, summary: desc || cmd.slice(0, 80), detail: cmd, defaultOpen: false }
    }
    case 'Task': {
      const desc = String(input.description ?? '')
      const prompt = String(input.prompt ?? '')
      return { toolName: name, id, summary: desc, detail: prompt, defaultOpen: false }
    }
    case 'Skill': {
      const skill = String(input.skill ?? '')
      return { toolName: name, id, summary: skill, detail: skill, defaultOpen: false }
    }
    default:
      return null
  }
}

function extractDisplayContent(line: ParsedSessionLine): DisplayContent {
  const empty: DisplayContent = { text: '', toolUses: [], toolSections: [], thinkingText: null, planText: null }
  const p = line.parsed
  if (!p) return { ...empty, text: line.raw.slice(0, 500) }

  if (p.type === 'summary' && p.summary) {
    return { ...empty, text: p.summary }
  }

  if (p.message?.content !== undefined) {
    const content = p.message.content
    if (typeof content === 'string') {
      return { ...empty, text: content }
    }
    if (Array.isArray(content)) {
      const textParts: string[] = []
      const thinkingParts: string[] = []
      const toolUses: ToolUseInfo[] = []
      const toolSections: ToolSection[] = []
      let planText: string | null = null
      for (const block of content) {
        if (block.type === 'text' && block.text) {
          textParts.push(block.text)
        } else if (block.type === 'thinking' && block.thinking) {
          thinkingParts.push(block.thinking)
        } else if (block.type === 'tool_use' && block.name) {
          const id = block.id ?? ''
          toolUses.push({ name: block.name, id })
          if (block.name === 'ExitPlanMode') {
            const input = block.input as Record<string, unknown> | undefined
            if (input && typeof input.plan === 'string') {
              planText = input.plan
            }
          }
          const input = block.input as Record<string, unknown> | undefined
          if (input) {
            const section = buildToolSection(block.name, id, input)
            if (section) toolSections.push(section)
          }
        }
      }
      return {
        text: textParts.join('\n'),
        toolUses,
        toolSections,
        thinkingText: thinkingParts.length > 0 ? thinkingParts.join('\n') : null,
        planText,
      }
    }
  }

  return empty
}

function getStrippedRejectionMessage(line: ParsedSessionLine): string | null {
  const content = line.parsed?.message?.content
  if (!Array.isArray(content)) return null
  for (const block of content) {
    if (block.type !== 'tool_result' || !block.is_error) continue
    const text = typeof block.content === 'string' ? block.content :
      Array.isArray(block.content) ? block.content.map(b => b.text ?? '').join('') : ''
    const marker = 'the user said:\n'
    const idx = text.indexOf(marker)
    if (idx !== -1) {
      let msg = text.slice(idx + marker.length)
      if (msg.endsWith('"')) msg = msg.slice(0, -1)
      return msg
    }
  }
  return null
}

const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

function formatTimestamp(ts: string, prevTs: string | undefined): string {
  const d = new Date(ts)
  const hours12 = d.getHours() % 12 || 12
  const minutes = String(d.getMinutes()).padStart(2, '0')
  const ampm = d.getHours() < 12 ? 'am' : 'pm'
  const timeStr = `${hours12}:${minutes} ${ampm}`

  if (prevTs) {
    const prev = new Date(prevTs)
    const sameDate =
      d.getFullYear() === prev.getFullYear() &&
      d.getMonth() === prev.getMonth() &&
      d.getDate() === prev.getDate()
    if (sameDate) return timeStr
  }

  return `${MONTH_NAMES[d.getMonth()]} ${d.getDate()}  ${timeStr}`
}

interface Props {
  line: ParsedSessionLine
  highlighted?: boolean
  sessionPath?: string
  reactions?: Map<string, 'approved' | 'rejected'>
  toolResults?: Map<string, ToolResultData>
  showAll?: boolean
  showThinking?: boolean
  showBash?: boolean
  showWrites?: boolean
  showTools?: boolean
  homeDir?: string
  onFocusLine?: (lineNumber: number) => void
  prevTimestamp?: string
}

function collapsePath(text: string, homeDir: string | undefined): string {
  if (!homeDir) return text
  // Replace homeDir prefix with ~ wherever it appears (e.g. in file paths)
  const suffix = homeDir.endsWith('/') ? homeDir : homeDir + '/'
  return text.replaceAll(suffix, '~/').replaceAll(homeDir, '~')
}

const HIDDEN_TOOLS = new Set(['Read', 'Grep', 'Glob', 'Bash', 'Write', 'Edit'])

function ToolResultOutput({ toolResults, toolUseId, homeDir, hideErrors }: {
  toolResults?: Map<string, ToolResultData>
  toolUseId: string
  homeDir?: string
  hideErrors?: boolean
}) {
  const result = toolResults?.get(toolUseId)
  if (!result) return null
  if (hideErrors && result.isError) return null
  return (
    <div className="tool-result-output">
      <div className="tool-result-output-header">Output{result.isError ? ' (error)' : ''}</div>
      <pre className={`tool-detail-content${result.isError ? ' tool-result-error' : ''}`}>
        {collapsePath(result.text, homeDir)}
      </pre>
    </div>
  )
}

export function SessionLine({ line, highlighted, sessionPath, reactions, toolResults, showAll, showThinking, showBash, showWrites, showTools, homeDir, onFocusLine, prevTimestamp }: Props) {
  const [showRaw, setShowRaw] = useState(false)
  const type = line.parsed?.type

  function copyLineRef() {
    if (!sessionPath) return
    const url = new URL(window.location.href)
    url.search = ''
    url.searchParams.set('file', sessionPath)
    url.searchParams.set('line', String(line.lineNumber))
    const ts = line.parsed?.timestamp
    if (ts) {
      const d = new Date(ts)
      const pad = (n: number) => String(n).padStart(2, '0')
      url.searchParams.set('t', `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`)
    }
    navigator.clipboard.writeText(url.toString())
    onFocusLine?.(line.lineNumber)
  }
  const timestamp = line.parsed?.timestamp
  const isMeta = type === 'user' && line.parsed?.isMeta === true
  const hasRejectionMessage = !isMeta && type === 'user' && getStrippedRejectionMessage(line) !== null
  const isToolResult = !isMeta && !hasRejectionMessage && type === 'user' && (() => {
    const content = line.parsed?.message?.content
    if (!Array.isArray(content)) return false
    return content[0]?.type === 'tool_result'
  })()
  const displayType = (isMeta || isToolResult) ? 'assistant' : type
  const { text, toolUses, toolSections, thinkingText, planText } = extractDisplayContent(line)
  const isMinorEvent = type === 'progress' || type === 'file-history-snapshot'
  const isChatBubble = type === 'user' || type === 'assistant'
  const [openSections, setOpenSections] = useState<Set<string>>(() => {
    const initial = new Set<string>()
    for (const s of toolSections) {
      if (s.defaultOpen) initial.add(s.id)
    }
    return initial
  })
  const toggleSection = (id: string) => {
    setOpenSections(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // For user tool-rejection-with-message lines, show stripped feedback when not in showAll mode
  const strippedMessage = !showAll && type === 'user' ? getStrippedRejectionMessage(line) : null
  const displayText = strippedMessage ?? text

  const messageReactions = toolUses
    .filter(tu => reactions?.has(tu.id))
    .map(tu => ({ name: tu.name, reaction: reactions!.get(tu.id)! }))

  // Build contextual pills for chat bubbles
  type ContentPill =
    | { kind: 'plan' }
    | { kind: 'tool'; section: ToolSection }
    | { kind: 'static'; label: string }
  const contentPills: ContentPill[] = []
  if (isMeta) contentPills.push({ kind: 'static', label: 'Skill Content' })
  if (isToolResult) contentPills.push({ kind: 'static', label: 'Tool Result' })
  if (hasRejectionMessage) contentPills.push({ kind: 'static', label: 'Feedback' })
  if (planText) contentPills.push({ kind: 'plan' })
  // Thinking is controlled entirely by the toolbar checkbox, not a pill
  // Map tool_use ids to sections for quick lookup
  const sectionById = new Map(toolSections.map(s => [s.id, s]))
  for (const tu of toolUses) {
    if (tu.name === 'ExitPlanMode') continue
    const section = sectionById.get(tu.id)
    if (section) {
      if (section.toolName === 'Bash') continue // Bash is shown inline via toolbar checkbox
      if (section.toolName === 'Write' || section.toolName === 'Edit') continue // Writes shown inline via toolbar checkbox
      if (!showAll && HIDDEN_TOOLS.has(section.toolName)) continue
      if (!showTools) continue
      if (section.toolName === 'Skill') {
        contentPills.push({ kind: 'static', label: `Skill: ${section.summary}` })
      } else {
        contentPills.push({ kind: 'tool', section })
      }
    } else {
      if (!showTools) continue
      contentPills.push({ kind: 'static', label: `${tu.name} Call` })
    }
  }

  const lineMeta = (
    <div className="line-meta">
      {timestamp && (
        <div className="line-meta-time">{formatTimestamp(timestamp, prevTimestamp)}</div>
      )}
      <div className="line-meta-row">
        <span className="line-number clickable" onClick={copyLineRef} title="Copy line reference">#{line.lineNumber}</span>
        <span className={`raw-json-icon${showRaw ? ' open' : ''}`} onClick={() => setShowRaw(!showRaw)} title="Toggle raw JSON">{'{}'}</span>
      </div>
    </div>
  )

  if (isChatBubble) {
    const bubble = (
      <div className={`chat-bubble ${displayType}${isMeta ? ' meta' : ''}${isToolResult ? ' tool-result' : ''}${messageReactions.length > 0 ? ' has-reactions' : ''}`}>
        {contentPills.length > 0 && (
          <div className="chat-bubble-header">
            {contentPills.map((pill, i) => {
              if (pill.kind === 'plan') {
                const isOpen = openSections.has('__plan__')
                return (
                  <span key={i} className={`type-badge ${getTypeBadgeClass(displayType)} clickable${isOpen ? ' open' : ''}`}
                    onClick={() => toggleSection('__plan__')}>
                    Plan{isOpen ? ' ▾' : ' ▸'}
                  </span>
                )
              }
              if (pill.kind === 'tool') {
                const { section } = pill
                const isOpen = openSections.has(section.id)
                return (
                  <span key={i} className={`type-badge ${getTypeBadgeClass(displayType)} clickable${isOpen ? ' open' : ''}`}
                    onClick={() => toggleSection(section.id)}
                    title={collapsePath(section.summary, homeDir)}>
                    {section.toolName} Call{isOpen ? ' ▾' : ' ▸'}
                  </span>
                )
              }
              return (
                <span key={i} className={`type-badge ${getTypeBadgeClass(displayType)}`}>
                  {pill.label}
                </span>
              )
            })}
          </div>
        )}

        {showRaw && (
          <pre className="raw-json">{JSON.stringify(line.parsed, null, 2)}</pre>
        )}

        {displayText && <div className="markdown-content"><Markdown remarkPlugins={[remarkGfm]}>{displayText}</Markdown></div>}

        {showThinking && thinkingText && <div className="markdown-content"><Markdown remarkPlugins={[remarkGfm]}>{thinkingText}</Markdown></div>}

        {showBash && toolSections.filter(s => s.toolName === 'Bash').map(section => (
          <div key={section.id} className="tool-detail">
            {section.summary !== section.detail && <div className="tool-detail-header">{section.summary}</div>}
            <pre className="tool-detail-content">{section.detail}</pre>
            <ToolResultOutput toolResults={toolResults} toolUseId={section.id} homeDir={homeDir} />
          </div>
        ))}

        {showWrites && toolSections.filter(s => (s.toolName === 'Write' || s.toolName === 'Edit') && !s.summary.includes('/.claude/plans/')).map(section => {
          const result = toolResults?.get(section.id)
          const isError = result?.isError
          if (isError && !showAll) return null
          return (
            <div key={section.id} className="tool-detail">
              <div className="tool-detail-header">{collapsePath(section.summary, homeDir)}</div>
              {section.toolName === 'Edit' ? (
                <pre className="tool-detail-content tool-detail-diff">
                  {collapsePath(section.detail, homeDir).split('\n').map((ln, j) => {
                    const cls = ln.startsWith('+ ') ? 'diff-add' : ln.startsWith('- ') ? 'diff-del' : ln.startsWith('---') || ln.startsWith('+++') ? 'diff-header' : ''
                    return <div key={j} className={cls}>{ln}</div>
                  })}
                </pre>
              ) : (
                <pre className="tool-detail-content">{collapsePath(section.detail, homeDir)}</pre>
              )}
              <ToolResultOutput toolResults={toolResults} toolUseId={section.id} homeDir={homeDir} />
            </div>
          )
        })}

        {openSections.has('__plan__') && planText && <div className="markdown-content"><Markdown remarkPlugins={[remarkGfm]}>{planText}</Markdown></div>}

        {showTools && toolSections.filter(s => showAll || !HIDDEN_TOOLS.has(s.toolName)).map(section => openSections.has(section.id) && (
          <div key={section.id} className="tool-detail">
            <div className="tool-detail-header">{collapsePath(section.summary, homeDir)}</div>
            {section.toolName === 'Edit' ? (
              <pre className="tool-detail-content tool-detail-diff">
                {collapsePath(section.detail, homeDir).split('\n').map((line, j) => {
                  const cls = line.startsWith('+ ') ? 'diff-add' : line.startsWith('- ') ? 'diff-del' : line.startsWith('---') || line.startsWith('+++') ? 'diff-header' : ''
                  return <div key={j} className={cls}>{line}</div>
                })}
              </pre>
            ) : (
              <pre className="tool-detail-content">{collapsePath(section.detail, homeDir)}</pre>
            )}
            <ToolResultOutput toolResults={toolResults} toolUseId={section.id} homeDir={homeDir} />
          </div>
        ))}

        {messageReactions.length > 0 && (
          <div className="chat-bubble-reactions">
            {messageReactions.map((r, i) => (
              <span key={i} className={`reaction-badge ${r.reaction}`} title={`${r.name}: ${r.reaction}`}>
                {r.reaction === 'approved' ? '👍' : '🚫'}
              </span>
            ))}
          </div>
        )}
      </div>
    )

    // assistant: bubble on left, meta on right; user: meta on left, bubble on right
    return (
      <div className={`chat-row ${displayType}${highlighted ? ' highlighted' : ''}`}>
        {displayType === 'user' ? <>{lineMeta}{bubble}</> : <>{bubble}{lineMeta}</>}
      </div>
    )
  }

  return (
    <div className={`session-line${highlighted ? ' highlighted' : ''}`}>
      {lineMeta}
      <div className="session-line-body">
        <span className={`type-badge ${getTypeBadgeClass(displayType)}`}>
          {type ?? 'unknown'}
        </span>

        {showRaw && (
          <pre className="raw-json">{JSON.stringify(line.parsed, null, 2)}</pre>
        )}

        {text && !isMinorEvent && (
          <div className="markdown-content"><Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown></div>
        )}

        {toolUses.length > 0 && (
          <div className="tool-use-summary">
            Tools: {toolUses.map(tu => tu.name).join(', ')}
          </div>
        )}
      </div>
    </div>
  )
}
