import { useCallback, useState } from 'react'

/**
 * State that outlives the tab, read through a parser that cannot throw.
 *
 * Two of the things on this screen are decisions rather than data — the shop's
 * own permission matrix, and which signatures the owner has already read — and
 * neither has a home in the contract yet. They live in `localStorage` until
 * Phase 5 gives them a table, which means they can also be absent, truncated,
 * or written by a build that is three contracts old. So the READER is the
 * argument: `read` is handed the raw string and is responsible for producing a
 * usable value from anything at all, including null.
 *
 * A write that fails is swallowed on purpose. Private-mode Safari throws on
 * `setItem` with a full quota, and a till that stops working because a
 * preference could not be saved is a worse outcome than a preference that does
 * not survive the session.
 */
export function usePersisted<T>(
  key: string,
  read: (raw: string | null) => T,
  write: (value: T) => string,
): readonly [T, (next: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      return read(localStorage.getItem(key))
    } catch {
      return read(null)
    }
  })

  const put = useCallback(
    (next: T) => {
      setValue(next)
      try {
        localStorage.setItem(key, write(next))
      } catch {
        /* Nothing to do and nothing to say: the value is live in this session. */
      }
    },
    [key, write],
  )

  return [value, put] as const
}
