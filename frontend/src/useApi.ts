import { useEffect, useState } from 'react'
import { ApiError } from './api'

export interface Remote<T> {
  data: T | null
  error: ApiError | Error | null
  loading: boolean
}

/**
 * Runs `load` whenever `deps` change and cancels the previous request.
 * The previous result is kept while the next one loads, so charts don't flash empty while a control is dragged.
 */
export function useRemote<T>(load: (signal: AbortSignal) => Promise<T>, deps: unknown[]): Remote<T> {
  const [state, setState] = useState<Remote<T>>({ data: null, error: null, loading: true })

  useEffect(() => {
    const controller = new AbortController()
    setState((s) => ({ ...s, loading: true }))
    load(controller.signal)
      .then((data) => setState({ data, error: null, loading: false }))
      .catch((error: Error) => {
        if (error.name === 'AbortError') return
        setState((s) => ({ data: error instanceof ApiError && error.status === 404 ? null : s.data, error, loading: false }))
      })
    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  return state
}

/** Returns `value` only after it has stopped changing for `ms`. Used to avoid one request per slider tick. */
export function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), ms)
    return () => clearTimeout(id)
  }, [value, ms])
  return debounced
}
