import { useState, useEffect } from 'react'
import type { ParsedSessionLine } from '../types'
import { fetchSession } from '../api'

function parseJsonl(text: string): ParsedSessionLine[] {
  return text
    .split('\n')
    .filter((line) => line.trim())
    .map((raw, i) => {
      let parsed: ParsedSessionLine['parsed'] = null
      try {
        parsed = JSON.parse(raw)
      } catch {
        // leave as null
      }
      return { lineNumber: i + 1, raw, parsed }
    })
}

export function useSession(path: string | null) {
  const [lines, setLines] = useState<ParsedSessionLine[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!path) {
      setLines([])
      return
    }

    setLoading(true)
    setError(null)

    fetchSession(path)
      .then((text) => {
        setLines(parseJsonl(text))
        setLoading(false)
      })
      .catch((err) => {
        setError(err.message)
        setLoading(false)
      })
  }, [path])

  return { lines, loading, error }
}
