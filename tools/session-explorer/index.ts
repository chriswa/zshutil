#!/usr/bin/env bun

import { statSync, readFileSync, existsSync } from 'fs'
import { basename, dirname, join, resolve } from 'path'
import {
  findAllSessionFiles,
  extractContent,
  parseLine,
  homeDir,
  claudeProjectsDir,
} from '../../claude/tools/session-search'
import type {
  SessionInfo,
  ProjectGroup,
  SessionsResponse,
  SearchRequest,
  SearchMatch,
  SearchResponse,
} from './types'

const PORT = 9127

function toDisplayPath(absPath: string): string {
  if (absPath.startsWith(homeDir)) {
    return '~' + absPath.slice(homeDir.length)
  }
  return absPath
}

function resolveUserPath(path: string): string {
  if (path.startsWith('~/') || path === '~') {
    return join(homeDir, path.slice(1))
  }
  return resolve(path)
}

// The dir name is the original absolute path with / replaced by -.
// Reversing this is ambiguous (dashes in dir names vs path separators),
// so we just strip the home dir prefix and show the rest as-is.
function dirNameToDisplayPath(dirName: string): string {
  const homeDirName = homeDir.replace(/\//g, '-')
  if (dirName === homeDirName) return '~'
  if (dirName.startsWith(homeDirName + '-')) {
    return '~/' + dirName.slice(homeDirName.length + 1)
  }
  return dirName
}

function buildSessionList(): SessionsResponse {
  const files = findAllSessionFiles()
  const groups = new Map<string, SessionInfo[]>()

  for (const filePath of files) {
    const stat = statSync(filePath)
    const sessionId = basename(filePath, '.jsonl')
    const parentDir = basename(dirname(filePath))

    const info: SessionInfo = {
      path: toDisplayPath(filePath),
      sessionId,
      lastModifiedAt: stat.mtime.toISOString(),
      sizeBytes: stat.size,
    }

    if (!groups.has(parentDir)) {
      groups.set(parentDir, [])
    }
    groups.get(parentDir)!.push(info)
  }

  const projects: ProjectGroup[] = [...groups.entries()]
    .map(([project, sessions]) => ({
      project,
      displayPath: dirNameToDisplayPath(project),
      sessions: sessions.sort((a, b) => b.lastModifiedAt.localeCompare(a.lastModifiedAt)),
    }))
    .sort((a, b) => b.sessions[0].lastModifiedAt.localeCompare(a.sessions[0].lastModifiedAt))

  return { homeDir, projects }
}

function searchSessions(req: SearchRequest): SearchResponse {
  const { query, userOnly, assistantOnly, startTime, endTime } = req

  // Build type filter
  let typeFilter: string[] | null = null
  if (userOnly && !assistantOnly) typeFilter = ['user']
  else if (assistantOnly && !userOnly) typeFilter = ['assistant']
  else if (userOnly && assistantOnly) typeFilter = ['user', 'assistant']

  // Build time filter as maxAgeMs
  let maxAgeMs: number | null = null
  if (startTime) {
    maxAgeMs = Date.now() - new Date(startTime).getTime()
  }

  const files = findAllSessionFiles(maxAgeMs)
  const results: SearchMatch[] = []
  const lowerQuery = query.toLowerCase()

  for (const filePath of files) {
    // If endTime specified, check file mtime
    if (endTime) {
      const stat = statSync(filePath)
      if (stat.mtime.toISOString() > endTime) continue
    }

    const content = readFileSync(filePath, 'utf8')
    const lines = content.split('\n').filter((l) => l.trim())
    const sessionId = basename(filePath, '.jsonl')

    let summary: string | null = null

    for (let i = 0; i < lines.length; i++) {
      const parsed = parseLine(lines[i])
      if (!parsed) continue

      // Grab summary while we're iterating
      if (parsed.type === 'summary' && parsed.summary) {
        summary = parsed.summary
      }

      // Apply type filter
      if (typeFilter && parsed.type && !typeFilter.includes(parsed.type)) {
        continue
      }

      // Check timestamp range if startTime/endTime provided
      if (parsed.timestamp) {
        if (startTime && parsed.timestamp < startTime) continue
        if (endTime && parsed.timestamp > endTime) continue
      }

      const text = extractContent(lines[i])
      if (text && text.toLowerCase().includes(lowerQuery)) {
        results.push({
          path: toDisplayPath(filePath),
          sessionId,
          summary,
          lineNumber: i + 1,
        })
      }
    }
  }

  return {
    results,
    totalMatches: results.length,
    sessionsSearched: files.length,
  }
}

function handleApiSessions(): Response {
  const data = buildSessionList()
  return Response.json(data)
}

function handleApiSession(url: URL): Response {
  const pathParam = url.searchParams.get('path')
  if (!pathParam) {
    return Response.json({ error: 'Missing path parameter' }, { status: 400 })
  }

  const resolved = resolveUserPath(pathParam)

  // Security: validate path is under claude projects dir and is a .jsonl file
  if (!resolved.startsWith(claudeProjectsDir) || !resolved.endsWith('.jsonl')) {
    return Response.json({ error: 'Invalid path' }, { status: 403 })
  }

  if (!existsSync(resolved)) {
    return Response.json({ error: 'File not found' }, { status: 404 })
  }

  const content = readFileSync(resolved, 'utf8')
  return new Response(content, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  })
}

async function handleApiSearch(req: Request): Promise<Response> {
  const body = (await req.json()) as SearchRequest
  if (!body.query) {
    return Response.json({ error: 'Missing query' }, { status: 400 })
  }
  const data = searchSessions(body)
  return Response.json(data)
}

function serveStatic(url: URL): Response {
  const distDir = join(import.meta.dir, 'frontend', 'dist')
  let filePath = join(distDir, url.pathname === '/' ? 'index.html' : url.pathname)

  if (!existsSync(filePath)) {
    filePath = join(distDir, 'index.html')
  }

  if (!existsSync(filePath)) {
    return new Response('Not found', { status: 404 })
  }

  const content = readFileSync(filePath)
  const ext = filePath.split('.').pop()
  const mimeTypes: Record<string, string> = {
    html: 'text/html',
    js: 'application/javascript',
    css: 'text/css',
    json: 'application/json',
    svg: 'image/svg+xml',
    png: 'image/png',
  }

  return new Response(content, {
    headers: { 'Content-Type': mimeTypes[ext ?? ''] ?? 'application/octet-stream' },
  })
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url)

    if (url.pathname === '/api/sessions') return handleApiSessions()
    if (url.pathname === '/api/session') return handleApiSession(url)
    if (url.pathname === '/api/search' && req.method === 'POST') return handleApiSearch(req)

    // Non-API routes: serve static files (production build)
    return serveStatic(url)
  },
})

console.log(`Session Explorer API running at http://localhost:${server.port}`)
