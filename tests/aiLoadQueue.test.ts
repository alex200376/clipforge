import { describe, expect, it } from 'vitest'

import { createQueue } from '../src/renderer/ai/queue'

describe('serialising model loads', () => {
  it('runs one piece of work at a time', async () => {
    // The bug this pins: two callers asking for the weights at the same moment both see
    // "not opened yet" and open the same 208 MB session, which is duplicated work rather
    // than a failure - the kind of thing that only ever looks like a slow app.
    const queue = createQueue()
    let concurrent = 0
    let peak = 0
    const step = async (): Promise<void> => {
      concurrent += 1
      peak = Math.max(peak, concurrent)
      await new Promise((resolve) => setTimeout(resolve, 5))
      concurrent -= 1
    }
    await Promise.all([queue.run(step), queue.run(step), queue.run(step)])
    expect(peak).toBe(1)
  })

  it('keeps the order the work was queued in', async () => {
    const queue = createQueue()
    const order: string[] = []
    const work = (name: string) => async (): Promise<void> => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      order.push(name)
    }
    const first = queue.run(work('first'))
    const second = queue.run(work('second'))
    await Promise.all([first, second])
    expect(order).toEqual(['first', 'second'])
  })

  it('hands a failure to the caller that asked for that work', async () => {
    const queue = createQueue()
    const failing = queue.run(async () => {
      throw new Error('the weights are not installed')
    })
    await expect(failing).rejects.toThrow('the weights are not installed')
  })

  it('still runs the work queued behind a failure', async () => {
    // A preload ignores its own failure and an export reports one, so a rejected piece
    // must not poison the queue: without this, a preload that could not open the weights
    // would make the export that followed fail with the preload's error instead of
    // opening them itself.
    const queue = createQueue()
    const failed = queue.run(async () => {
      throw new Error('the runtime did not start')
    })
    const recovered = queue.run(async () => 'opened')
    await expect(failed).rejects.toThrow('the runtime did not start')
    await expect(recovered).resolves.toBe('opened')
  })

  it('resolves each caller with its own result', async () => {
    const queue = createQueue()
    const results = await Promise.all([
      queue.run(async () => 'webgpu'),
      queue.run(async () => 'wasm')
    ])
    expect(results).toEqual(['webgpu', 'wasm'])
  })
})
