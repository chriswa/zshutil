#!/usr/bin/env bun

import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'fs'
import { homedir } from 'os'
import { basename, dirname, join, relative } from 'path'
import { execFileSync } from 'child_process'

const HOME = homedir()
const WT_BASE = join(HOME, 'wt')

// All progress output goes to stderr (shell wrapper captures only stdout for the cd path)
function log(msg: string) {
  process.stderr.write(msg + '\n')
}

function error(msg: string): never {
  process.stderr.write(`Error: ${msg}\n`)
  process.exit(1)
}

function git(repoPath: string, ...args: string[]): string {
  try {
    return execFileSync('git', ['-C', repoPath, ...args], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
  } catch (e: any) {
    throw new Error(e.stderr?.trim() || e.message)
  }
}

function apfsClone(src: string, dest: string): void {
  mkdirSync(dirname(dest), { recursive: true })
  execFileSync('cp', ['-cR', src, dest], { stdio: 'pipe' })
}

function gitOk(repoPath: string, ...args: string[]): boolean {
  try {
    execFileSync('git', ['-C', repoPath, ...args], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

// Run a git command with stderr visible to the user (for fetch progress, etc.)
function gitVisible(repoPath: string, ...args: string[]): void {
  execFileSync('git', ['-C', repoPath, ...args], {
    stdio: ['pipe', 'pipe', 'inherit'],
  })
}

function resolveRepoContext(): { repoPath: string; repoName: string } {
  let repoPath: string
  try {
    repoPath = git('.', 'rev-parse', '--show-toplevel')
  } catch {
    error('Not in a git repository')
  }

  const cwd = process.cwd()
  let repoName: string
  if (cwd.startsWith(WT_BASE + '/')) {
    const rel = cwd.slice(WT_BASE.length + 1)
    repoName = rel.split('/')[0]
  } else {
    repoName = basename(repoPath)
  }

  return { repoPath, repoName }
}

function resolveParent(parentArg: string, repoName: string): string {
  let parentPath: string

  if (parentArg.startsWith('~')) {
    parentPath = parentArg.replace(/^~/, HOME)
  } else if (parentArg.startsWith('/') || parentArg.startsWith('.')) {
    parentPath = parentArg
  } else {
    // Plain name → worktree name under ~/wt/<repo>/
    parentPath = join(WT_BASE, repoName, parentArg)
  }

  if (!existsSync(parentPath)) {
    error(`Parent path does not exist: ${parentPath}`)
  }

  if (!gitOk(parentPath, 'rev-parse', '--show-toplevel')) {
    error(`Parent path is not a git working tree: ${parentPath}`)
  }

  return parentPath
}

function detectDefaultBranch(repoPath: string): string {
  try {
    const ref = git(repoPath, 'symbolic-ref', 'refs/remotes/origin/HEAD')
    return ref.replace(/^refs\/remotes\/origin\//, '')
  } catch {
    if (gitOk(repoPath, 'show-ref', '--verify', '--quiet', 'refs/remotes/origin/main')) return 'main'
    if (gitOk(repoPath, 'show-ref', '--verify', '--quiet', 'refs/remotes/origin/master')) return 'master'
    error('Could not determine default branch')
  }
}

// --- Single recursive walk: .env files and node_modules dirs ---

interface WalkResult {
  envFiles: string[]
  nodeModulesDirs: string[]
}

function walk(root: string): WalkResult {
  const envFiles: string[] = []
  const nodeModulesDirs: string[] = []

  function recurse(dir: string) {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      if (entry.name === '.git') continue

      if (entry.name === 'node_modules') {
        nodeModulesDirs.push(join(dir, entry.name))
        continue // don't recurse into node_modules
      }

      if (entry.name === '.env' && entry.isFile()) {
        envFiles.push(join(dir, entry.name))
      }

      if (entry.isDirectory()) {
        recurse(join(dir, entry.name))
      }
    }
  }

  recurse(root)
  return { envFiles, nodeModulesDirs }
}

// --- Remaining gitignored items ---

function countFilesInDir(dir: string): number {
  let count = 0
  try {
    const entries = readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isFile() || entry.isSymbolicLink()) {
        count++
      } else if (entry.isDirectory()) {
        count += countFilesInDir(join(dir, entry.name))
      }
    }
  } catch {}
  return count
}

interface GitIgnoredEntry {
  relativePath: string
  isDir: boolean
  fileCount?: number
}

function findRemainingGitignored(parentPath: string): GitIgnoredEntry[] {
  let output: string
  try {
    output = git(parentPath, 'ls-files', '--others', '--ignored', '--exclude-standard', '--directory')
  } catch {
    return []
  }

  if (!output) return []

  const entries: GitIgnoredEntry[] = []
  for (const line of output.split('\n')) {
    if (!line) continue

    const isDir = line.endsWith('/')
    const cleanPath = isDir ? line.slice(0, -1) : line

    // Filter out node_modules and .env (already handled)
    const parts = cleanPath.split('/')
    if (parts.includes('node_modules')) continue
    if (parts[parts.length - 1] === '.env') continue

    const entry: GitIgnoredEntry = { relativePath: cleanPath, isDir }
    if (isDir) {
      entry.fileCount = countFilesInDir(join(parentPath, cleanPath))
    }
    entries.push(entry)
  }

  return entries
}

function cloneRemaining(entries: GitIgnoredEntry[], parentPath: string, worktreePath: string): void {
  for (const entry of entries) {
    const src = join(parentPath, entry.relativePath)
    const dest = join(worktreePath, entry.relativePath)
    if (existsSync(dest)) continue
    if (entry.isDir) {
      apfsClone(src, dest)
    } else {
      mkdirSync(dirname(dest), { recursive: true })
      copyFileSync(src, dest)
    }
  }
}

function formatRemainingReport(entries: GitIgnoredEntry[]): void {
  // Group by parent directory for compact display
  const groups = new Map<string, { name: string; isDir: boolean; fileCount?: number }[]>()

  for (const entry of entries) {
    const parts = entry.relativePath.split('/')
    let parent: string
    let name: string

    if (parts.length === 1) {
      parent = ''
      name = entry.relativePath
    } else {
      name = parts.pop()!
      parent = parts.join('/')
    }

    if (!groups.has(parent)) groups.set(parent, [])
    groups.get(parent)!.push({ name, isDir: entry.isDir, fileCount: entry.fileCount })
  }

  const lines: string[] = []
  for (const [parent, items] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (parent === '') {
      for (const item of items) {
        const suffix = item.isDir && item.fileCount ? ` (${item.fileCount} files)` : ''
        const slash = item.isDir ? '/' : ''
        lines.push(`  ${item.name}${slash}${suffix}`)
      }
    } else {
      const parts = items.map(item => {
        const slash = item.isDir ? '/' : ''
        const suffix = item.isDir && item.fileCount ? ` (${item.fileCount})` : ''
        return `${item.name}${slash}${suffix}`
      })
      lines.push(`  ${parent}: ${parts.join(', ')}`)
    }
  }

  log(`⚠ Cloned ${entries.length} additional gitignored paths:`)
  for (const line of lines) {
    log(line)
  }
}

// --- Main ---

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const secs = ms / 1000
  if (secs < 60) return `${secs.toFixed(1)}s`
  const mins = Math.floor(secs / 60)
  const remainSecs = secs % 60
  return `${mins}m ${remainSecs.toFixed(0)}s`
}

function main() {
  const startTime = Date.now()
  const args = process.argv.slice(2)

  if (args.length === 0) {
    log('Usage: wt-spawn <branch-name> [parent]')
    log('  parent: worktree name, path (~/ supported), or omitted (uses repo root)')
    log('Example: wt-spawn my-feature')
    log('Example: wt-spawn my-feature other-worktree')
    log('Example: wt-spawn my-feature ~/spare')
    process.exit(1)
  }

  const branchName = args[0]
  const parentArg = args[1]

  const { repoPath, repoName } = resolveRepoContext()
  const worktreePath = join(WT_BASE, repoName, branchName)

  // Idempotent: if worktree already exists, just output path for cd
  if (existsSync(worktreePath)) {
    log(`Worktree already exists at ${worktreePath}`)
    process.stdout.write(worktreePath + '\n')
    return
  }

  // Resolve parent
  let parentPath: string
  if (parentArg) {
    parentPath = resolveParent(parentArg, repoName)
  } else {
    parentPath = repoPath
  }

  // Emit target path immediately so consumers can start preparing
  process.stdout.write(worktreePath + '\n')

  // Create worktree
  log(`Creating worktree at ${worktreePath}...`)
  mkdirSync(join(WT_BASE, repoName), { recursive: true })

  log('Fetching from origin...')
  try {
    gitVisible(repoPath, 'fetch', 'origin')
  } catch (e: any) {
    error(`Failed to fetch: ${e.stderr?.trim() || e.message}`)
  }

  if (parentArg) {
    let parentHead: string
    try {
      parentHead = git(parentPath, 'rev-parse', 'HEAD')
    } catch {
      error(`Could not resolve HEAD of parent: ${parentPath}`)
    }
    const shortHead = git(parentPath, 'rev-parse', '--short', 'HEAD')
    log(`✓ Creating branch '${branchName}' from parent HEAD (${shortHead})`)
    try {
      gitVisible(repoPath, 'worktree', 'add', worktreePath, '-b', branchName, parentHead)
    } catch (e: any) {
      error(`Failed to create worktree: ${e.stderr?.trim() || e.message}`)
    }
  } else {
    const defaultBranch = detectDefaultBranch(repoPath)
    log(`✓ Creating branch '${branchName}' from origin/${defaultBranch}`)
    try {
      gitVisible(repoPath, 'worktree', 'add', '--no-track', worktreePath, '-b', branchName, `origin/${defaultBranch}`)
    } catch (e: any) {
      error(`Failed to create worktree: ${e.stderr?.trim() || e.message}`)
    }
  }

  // Single recursive walk to find .env files and node_modules dirs
  log(`Scanning parent: ${parentPath}`)
  const { envFiles, nodeModulesDirs } = walk(parentPath)

  for (const envFile of envFiles) {
    const relPath = relative(parentPath, envFile)
    const dest = join(worktreePath, relPath)
    mkdirSync(dirname(dest), { recursive: true })
    copyFileSync(envFile, dest)
  }
  log(`✓ Copied ${envFiles.length} .env files`)

  for (const nmDir of nodeModulesDirs) {
    const relPath = relative(parentPath, nmDir)
    const dest = join(worktreePath, relPath)
    apfsClone(nmDir, dest)
  }
  log(`✓ Cloned ${nodeModulesDirs.length} node_modules directories`)

  // Clone remaining gitignored items (build artifacts, caches, etc.)
  const remaining = findRemainingGitignored(parentPath)
  if (remaining.length > 0) {
    cloneRemaining(remaining, parentPath, worktreePath)
    formatRemainingReport(remaining)
  }

  const elapsed = formatDuration(Date.now() - startTime)
  log(`✓ Ready in ${worktreePath} (${elapsed})`)
}

main()
