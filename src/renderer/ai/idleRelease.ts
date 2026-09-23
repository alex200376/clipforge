/**
 * Releases an expensive resource only after all callers have let go and it has stayed idle
 * for the requested grace period. A later caller cancels the pending release.
 */
export interface IdleReleaseController {
  /** Keeps the resource alive until the returned idempotent release function is called. */
  hold(): () => void
  /** Cancels a pending release, typically when new work is about to begin. */
  cancel(): void
  /** True while no work has a hold on the resource. */
  readonly isIdle: boolean
}

export function createIdleReleaseController(
  delayMs: number,
  release: () => void,
  timers: Pick<typeof globalThis, 'setTimeout' | 'clearTimeout'> = globalThis
): IdleReleaseController {
  let active = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let releasing = false
  let generation = 0

  const cancel = (): void => {
    generation += 1
    if (timer !== null) timers.clearTimeout(timer)
    timer = null
  }

  const schedule = (): void => {
    if (active > 0 || timer !== null || releasing) return
    const scheduledGeneration = generation
    timer = timers.setTimeout(() => {
      timer = null
      if (active > 0 || scheduledGeneration !== generation) return
      releasing = true
      try {
        release()
      } catch {
        // Releasing is best effort; a stale GPU session must not take down the renderer.
      } finally {
        releasing = false
        if (active === 0 && scheduledGeneration !== generation) schedule()
      }
    }, Math.max(0, delayMs))
  }

  return {
    hold(): () => void {
      cancel()
      active += 1
      let held = true
      return () => {
        if (!held) return
        held = false
        active = Math.max(0, active - 1)
        schedule()
      }
    },
    cancel,
    get isIdle() {
      return active === 0
    }
  }
}
