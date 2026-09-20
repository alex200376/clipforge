/**
 * How hard the AI removal is allowed to push the GPU.
 *
 * A watermark pass is minutes of sustained inference, and on a laptop that is minutes of
 * a discrete card sitting at its power limit while the CPU decodes, encodes and moves the
 * same frames next to it - on most gaming laptops the two share heatpipes, so they heat
 * each other. Measured on the machine this was written for, an RTX 3060 Laptop under an
 * unbranched AI export settles around 80 degrees and holds it for as long as the export
 * lasts, while the same card at idle is 57 degrees and 10 watts.
 *
 * The lever is not to do the work differently - the fill has to come out of the same
 * weights - but to do it in bursts instead of continuously. Equilibrium temperature on a
 * laptop is a function of *average* power, so the control this module exposes is a duty
 * cycle: the share of wall time the GPU is busy. A gap between batches long enough for the
 * card to fall back toward idle costs export time and buys back temperature.
 *
 * Nothing here touches the pixels. Two exports of the same clip at different duties must
 * be byte-identical; only how long they take may differ.
 */

/** The modes as the settings file and the UI spell them. */
export const AI_POWER_MODES = ['auto', 'fast', 'balanced', 'quiet'] as const

export type AiPowerMode = (typeof AI_POWER_MODES)[number]

/**
 * A mode with the ambiguity taken out of it.
 *
 * `auto` is not a pace, it is a question about the power source, and `resolvePace` is the
 * only thing that answers it. Everything downstream then has a number it can act on,
 * which is what keeps the loop free of the decision.
 */
export interface AiPace {
  mode: Exclude<AiPowerMode, 'auto'>
  /** Share of wall time the GPU may be busy, 1 being "no pause at all". */
  duty: number
}

/**
 * The duty each mode allows.
 *
 * `fast` is exactly 1 so that the default path - and every export from every earlier
 * version - runs with no timer and no gap at all.
 *
 * The two paced values were measured on a 241-frame AI export of a 768x1152 clip, with the
 * card traced once a second (RTX 3060 Laptop, 85 W TGP):
 *
 * |           | export | the card at work | peak  | last third | mean draw |
 * | fast      |  194 s |          85% of it | 89 C  |     84.8 C |   57.4 W  |
 * | quiet     |  285 s |          53% of it | 89 C  |     82.9 C |   50.2 W  |
 *
 * That is the shape these two numbers should be judged by, and it is deliberately not a
 * promise of a cooler peak. The card does not reach a lower ceiling: an export is not only
 * the inpainting pass, and the encode that follows it is not paced, so the peak is set
 * there and comes out the same either way. What the pace buys is a fifth less average
 * power, a visibly cooler first ninety seconds (75 C against 85 C at the same moment), and
 * less time spent at the top of the range - for a pass that takes 1.7x as long, and an
 * export as a whole about 1.5x. If those numbers ever stop being worth it, these are the
 * two constants to argue with.
 */
const DUTY: Record<AiPace['mode'], number> = {
  fast: 1,
  balanced: 0.8,
  quiet: 0.6
}

/**
 * The pace a mode means on this power source.
 *
 * `auto` is the only interesting case, and it is deliberately asymmetric: plugged in, the
 * machine is on a desk with a fan curve that can afford the full rate, so `auto` is
 * `fast`. On battery, the user is holding the laptop and the heat is against their legs, so
 * `auto` is `quiet` - the cool end rather than the middle one.
 *
 * Worth knowing when reading that second answer: a paced export runs for longer than a
 * full-rate one, so this is a choice about *instantaneous* power rather than about the
 * battery's total. Measured over a 241-frame run, quiet drew 50.2 W for 285 s against
 * fast's 57.4 W for 194 s - cooler to sit next to, and not obviously cheaper in watt-hours.
 *
 * The battery reading is passed in rather than looked up here, so both branches are
 * testable without unplugging anything.
 */
export function resolvePace(mode: AiPowerMode, onBattery: boolean): AiPace {
  if (mode !== 'auto') return { mode, duty: DUTY[mode] }
  const picked: AiPace['mode'] = onBattery ? 'quiet' : 'fast'
  return { mode: picked, duty: DUTY[picked] }
}

/**
 * A ceiling on a single pause.
 *
 * Duty-proportional means "as long as the work took", which is right up until the
 * measurement is wrong: a clock adjustment, a sleeping machine or a suspended tab can make
 * one batch look like it took an hour, and an export that then rests for most of an hour
 * would look like the hang this app has been accused of before. Longer than any real
 * batch, short enough that the worst case is a pause rather than a stall.
 */
export const AI_PAUSE_MAX_MS = 5 * 60 * 1000

/**
 * How long to rest after `workMs` of inference to hold the given duty.
 *
 * Derived from the duty rather than written down as a number of milliseconds: `work / (work
 * + pause) = duty`, so the pause is `work * (1 - duty) / duty`. That is what makes the
 * setting meaningful across machines - a fast card and a slow card both end up spending the
 * same *share* of their time idle, which is the thing average power depends on, instead of
 * the fixed delay that would be a rounding error on one and a stall on the other.
 */
export function pauseMs(workMs: number, duty: number): number {
  if (!Number.isFinite(workMs) || workMs <= 0) return 0
  if (!Number.isFinite(duty) || duty >= 1) return 0
  // A duty that is zero or negative would mean "never run", which is not a pace.
  const share = Math.max(0, duty)
  if (share <= 0) return 0
  return Math.min(AI_PAUSE_MAX_MS, Math.round((workMs * (1 - share)) / share))
}

/** Whether a value from the settings file or the UI is a mode this app knows. */
export function isAiPowerMode(value: unknown): value is AiPowerMode {
  return typeof value === 'string' && (AI_POWER_MODES as readonly string[]).includes(value)
}

/**
 * The pace of a run, for a note that says why it is taking this long.
 *
 * A paced export is slower by design, and a number without a reason in front of it reads as
 * a slow machine - which is exactly the conclusion the rate note exists to prevent.
 */
export function paceNote(pace: AiPace): string {
  return pace.mode === 'fast' ? 'full speed' : `${pace.mode} mode`
}
