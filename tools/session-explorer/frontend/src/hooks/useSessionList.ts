import { useState, useEffect } from 'react'
import type { ProjectGroup } from '../types'
import { fetchSessions } from '../api'

export function useSessionList() {
  const [projects, setProjects] = useState<ProjectGroup[]>([])
  const [homeDir, setHomeDir] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetchSessions()
      .then((data) => {
        setProjects(data.projects)
        setHomeDir(data.homeDir)
        setLoading(false)
      })
      .catch((err) => {
        setError(err.message)
        setLoading(false)
      })
  }, [])

  return { projects, homeDir, loading, error }
}
