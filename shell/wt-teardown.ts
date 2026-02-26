#!/usr/bin/env bun

import { existsSync, lstatSync, statSync } from 'fs'
import { homedir } from 'os'
import { basename, join } from 'path'
import { execFileSync } from 'child_process'

const HOME = homedir()
const WT_BASE = join(HOME, 'wt')

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

function gitOk(repoPath: string, ...args: string[]): boolean {
  try {
    execFileSync('git', ['-C', repoPath, ...args], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

function gitVisible(repoPath: string, ...args: string[]): void {
  execFileSync('git', ['-C', repoPath, ...args], {
    stdio: ['pipe', 'pipe', 'inherit'],
  })
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

function getMainRepoPath(worktreePath: string): string {
  const output = git(worktreePath, 'worktree', 'list', '--porcelain')
  const firstLine = output.split('\n')[0]
  return firstLine.replace('worktree ', '')
}

function isWorktree(path: string): boolean {
  // In a worktree, .git is a file (not a directory) containing "gitdir: ..."
  const gitPath = join(path, '.git')
  try {
    const stat = statSync(gitPath)
    return stat.isFile()
  } catch {
    return false
  }
}

function main() {
  const args = process.argv.slice(2)
  const force = args.includes('--force')
  const nameArgs = args.filter(a => !a.startsWith('--'))

  if (nameArgs.length > 1) {
    log('Usage: wt-teardown [name] [--force]')
    log('  name: worktree name (or omit to use current directory)')
    log('  --force: remove even with untracked files')
    process.exit(1)
  }

  const nameArg = nameArgs[0]

  // Resolve worktree path
  let worktreePath: string
  if (nameArg) {
    const cwd = process.cwd()
    let repoName: string
    if (cwd.startsWith(WT_BASE + '/')) {
      const rel = cwd.slice(WT_BASE.length + 1)
      repoName = rel.split('/')[0]
    } else {
      try {
        const repoPath = git('.', 'rev-parse', '--show-toplevel')
        repoName = basename(repoPath)
      } catch {
        error('Not in a git repository — cannot resolve worktree name')
      }
    }
    worktreePath = join(WT_BASE, repoName, nameArg)
  } else {
    worktreePath = process.cwd()
  }

  if (!existsSync(worktreePath)) {
    error(`Worktree does not exist: ${worktreePath}`)
  }

  if (!isWorktree(worktreePath)) {
    error(`Not a git worktree: ${worktreePath}`)
  }

  const mainRepoPath = getMainRepoPath(worktreePath)
  const branchName = git(worktreePath, 'branch', '--show-current')
  const defaultBranch = detectDefaultBranch(mainRepoPath)

  log(`Worktree: ${worktreePath}`)
  log(`Branch: ${branchName}`)

  // Safety check 1: uncommitted changes (staged or unstaged, but not untracked ??)
  const status = git(worktreePath, 'status', '--porcelain')
  const statusLines = status ? status.split('\n').filter(l => l.trim()) : []
  const modifiedLines = statusLines.filter(l => !l.startsWith('??'))

  if (modifiedLines.length > 0) {
    log('')
    log('Cannot remove: worktree has uncommitted changes:')
    for (const line of modifiedLines) {
      log(`  ${line}`)
    }
    process.exit(1)
  }

  // Safety check 2: commits not on the default branch
  let unpushed = ''
  try {
    unpushed = git(worktreePath, 'log', `origin/${defaultBranch}..HEAD`, '--oneline')
  } catch {}

  if (unpushed) {
    log('')
    log(`Cannot remove: worktree has commits not on origin/${defaultBranch}:`)
    for (const line of unpushed.split('\n')) {
      log(`  ${line}`)
    }
    process.exit(1)
  }

  // Safety check 3: untracked non-ignored files
  // Symlinks created by wt-spawn (node_modules, dist, etc.) appear as "untracked"
  // because git's directory-only gitignore patterns (e.g. node_modules/) don't match
  // symlinks. Filter those out — only warn about real user-created files.
  let untracked = ''
  try {
    untracked = git(worktreePath, 'ls-files', '--others', '--exclude-standard')
  } catch {}

  const untrackedFiles = untracked
    ? untracked.split('\n').filter(l => {
        if (!l.trim()) return false
        try {
          return !lstatSync(join(worktreePath, l)).isSymbolicLink()
        } catch {
          return true
        }
      })
    : []

  if (untrackedFiles.length > 0 && !force) {
    log('')
    log('Worktree has untracked files:')
    for (const file of untrackedFiles) {
      log(`  ${file}`)
    }
    log('')
    log('Run with --force to remove anyway.')
    process.exit(1)
  }

  // All clear — remove
  log('')
  log('Removing worktree...')
  try {
    gitVisible(mainRepoPath, 'worktree', 'remove', '--force', worktreePath)
  } catch (e: any) {
    error(`Failed to remove worktree: ${e.message}`)
  }
  log('✓ Removed worktree')

  try {
    git(mainRepoPath, 'branch', '-d', branchName)
    log(`✓ Deleted branch '${branchName}'`)
  } catch {
    log(`⚠ Could not delete branch '${branchName}' (may have unmerged changes)`)
  }

  // If user was in the removed worktree, output path to cd to
  if (process.cwd().startsWith(worktreePath)) {
    process.stdout.write(mainRepoPath + '\n')
  }
}

main()
