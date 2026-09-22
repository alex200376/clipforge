/**
 * The notice queue's two rules, and the third that only shows up in use.
 *
 * The queue exists because the workspace used to pay for its notices in pixels. These tests
 * pin the behaviour the stack relies on: one card per kind, a bounded corner, and the
 * difference between a notice that reports and one that waits for an answer - since getting
 * the last one wrong means a user never learns their update was ready.
 */

import { describe, expect, it } from 'vitest'

import {
  EMPTY_QUEUE,
  MAX_NOTICES,
  dismissKind,
  dismissNotice,
  isSticky,
  pushNotice
} from '../src/renderer/notices'
import type { NoticeDraft, NoticeKind } from '../src/renderer/notices'


const draft = (kind: NoticeKind, title: string = kind): NoticeDraft => ({ kind, title, actions: [] })

describe('the notice queue', () => {
  it('numbers notices so a replacement restarts its countdown', () => {
    const first = pushNotice(EMPTY_QUEUE, draft('clip-loaded'))
    const second = pushNotice(first, draft('clip-loaded'))
    expect(second.items).toHaveLength(1)
    expect(second.items[0]!.id).toBeGreaterThan(first.items[0]!.id)
  })

  it('replaces a notice of the same kind instead of stacking it', () => {
    // Loading three clips in a row must not leave three cards, and a download that reports
    // progress must not push one card per percent.
    let queue = pushNotice(EMPTY_QUEUE, draft('clip-loaded', 'a.mp4'))
    queue = pushNotice(queue, draft('clip-loaded', 'b.mp4'))
    queue = pushNotice(queue, draft('clip-loaded', 'c.mp4'))
    expect(queue.items.map((item) => item.title)).toEqual(['c.mp4'])
  })

  it('keeps different kinds side by side', () => {
    let queue = pushNotice(EMPTY_QUEUE, draft('clip-loaded'))
    queue = pushNotice(queue, draft('update-ready'))
    queue = pushNotice(queue, draft('guide'))
    expect(queue.items.map((item) => item.kind)).toEqual(['clip-loaded', 'update-ready', 'guide'])
  })

  it('caps the corner, dropping what has already been read', () => {
    let queue = EMPTY_QUEUE
    for (const kind of ['clip-loaded', 'export-done', 'update-ready', 'guide', 'resume-last'] as const) {
      queue = pushNotice(queue, draft(kind))
    }
    expect(queue.items).toHaveLength(MAX_NOTICES)
    // Both transients are gone before either decision is.
    expect(queue.items.map((item) => item.kind)).toEqual(['update-ready', 'guide', 'resume-last'])
  })

  it('drops the oldest even when every notice is waiting on an answer', () => {
    let queue = EMPTY_QUEUE
    for (const kind of ['update-ready', 'guide', 'resume-last', 'leftover-install'] as const) {
      queue = pushNotice(queue, draft(kind))
    }
    expect(queue.items.map((item) => item.kind)).toEqual(['guide', 'resume-last', 'leftover-install'])
  })

  it('dismisses by id, and leaves an unknown id alone', () => {
    const queue = pushNotice(pushNotice(EMPTY_QUEUE, draft('clip-loaded')), draft('guide'))
    const [first, second] = queue.items
    const withoutFirst = dismissNotice(queue, first!.id)
    expect(withoutFirst.items.map((item) => item.kind)).toEqual(['guide'])
    // Same object back, so a stray close cannot churn React state.
    expect(dismissNotice(withoutFirst, 999)).toBe(withoutFirst)
    expect(dismissNotice(withoutFirst, second!.id).items).toEqual([])
  })

  it('can be cleared by kind, for an action that finishes its job', () => {
    let queue = pushNotice(EMPTY_QUEUE, draft('export-done'))
    queue = pushNotice(queue, draft('clip-loaded'))
    expect(dismissKind(queue, 'export-done').items.map((item) => item.kind)).toEqual(['clip-loaded'])
    // Nothing of that kind, nothing to do - and the same object back, so React does not
    // re-render the stack for a no-op.
    expect(dismissKind(dismissKind(queue, 'guide'), 'guide')).toEqual(queue)
  })

  it('waits for an answer only on the notices that ask one', () => {
    expect(isSticky('export-done')).toBe(false)
    expect(isSticky('clip-loaded')).toBe(false)
    for (const kind of ['update-ready', 'resume-last', 'leftover-install', 'guide'] as const) {
      expect(isSticky(kind)).toBe(true)
    }
  })
})
