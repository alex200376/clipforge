/**
 * Runs asynchronous work one piece at a time, in the order it was asked for.
 *
 * It exists for one reason: opening the AI weights is expensive and cannot be
 * interrupted, so two callers wanting them at once must share the work rather than
 * repeat it. The three callers are the export that needs the inpainter, the search that
 * needs only the detector, and the preload that opens them while the user is still
 * arranging the clip - and the preload makes the overlap ordinary rather than rare,
 * because it starts on its own.
 *
 * A failure is not fatal to the queue: it is handed to the caller that asked for that
 * piece of work, and the next piece still runs. That matters because the callers treat
 * failure differently - a preload ignores it, an export reports it - so the queue must
 * not decide either way.
 */
export interface WorkQueue {
  /** Queues `work` behind everything already queued, and resolves with its result. */
  run<T>(work: () => Promise<T>): Promise<T>
}

export function createQueue(): WorkQueue {
  let tail: Promise<unknown> = Promise.resolve()
  return {
    run<T>(work: () => Promise<T>): Promise<T> {
      // Both handlers are given the same work, so a rejected piece cannot stop the queue:
      // without the second handler the tail stays rejected and every later piece fails
      // with someone else's error.
      const next = tail.then(work, work)
      tail = next.then(
        () => undefined,
        () => undefined
      )
      return next
    }
  }
}
