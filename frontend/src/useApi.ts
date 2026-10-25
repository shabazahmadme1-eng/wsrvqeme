import { useEffect, useRef, useState } from 'react'
import { ApiError } from './api'

export interface Remote<T> {
  data: T | null
  error: ApiError | Error | null
  loading: boolean
}

/**
 * Runs `load` whenever `deps` change and cancels the previous request.
 * The previous result is kept while the next one loads, so charts don't flash empty while a control is dragged.
 *
 * `deps` is serialised into a key and the effect depends on that key alone. Callers pass `load` as an inline
 * closure, which is a new function on every render and so cannot itself be a dependency; the latest one is read
 * from a ref instead.
 */
export function useRemote<T>(load: (signal: AbortSignal) => Promise<T>, deps: unknown[]): Remote<T> {
  // `settled.key` records which request the stored result belongs to, so `loading` is derived
  // (the current key has not settled yet) rather than set synchronously inside the effect.
  const [settled, setSettled] = useState<{ key: string; data: T | null; error: Error | null }>({ key: '', data: null, error: null })
  const loadRef = useRef(load)
  useEffect(() => {
    loadRef.current = load
  })
  const key = JSON.stringify(deps)

  useEffect(() => {
    const controller = new AbortController()
    loadRef
      .current(controller.signal)
      .then((data) => setSettled({ key, data, error: null }))
      .catch((error: Error) => {
        if (error.name === 'AbortError') return
        setSettled((s) => ({ key, data: error instanceof ApiError && error.status === 404 ? null : s.data, error }))
      })
    return () => controller.abort()
  }, [key])

  // An error belongs to the request that raised it: while a newer one is loading, don't show it.
  return { data: settled.data, error: settled.key === key ? settled.error : null, loading: settled.key !== key }
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
