# A TDD Kata: `useIdleTimeout`

One composable, built red → green → refactor, one commit per step. The commits
are real and they are on the branch that introduced this file:

| Step | Commit subject                                                               |
| ---- | ---------------------------------------------------------------------------- |
| 1    | `test: specify useIdleTimeout before writing it (kata step 1 — red)`         |
| 2    | `feat: useIdleTimeout, the simplest thing that passes (kata step 2 — green)` |
| 3    | `refactor: extract planIdleStep, which found a real bug (kata step 3)`       |

`main` carries them squashed, which is this repository's merge rule. The three
separate commits, with their full messages and diffs, are on the pull request
that added this document — GitHub keeps a merged PR's commits reachable after
the branch is deleted.

The point of writing it down is not that TDD is unfamiliar. It is that the
interesting part of a kata is invisible in the finished code: which assertion
forced which design decision, and what the refactor step actually bought. Both
are recorded below, including the bug step 3 found in step 2's work.

## The subject, and why it is this one

`useIdleTimeout` watches for user inactivity and announces a warning and then a
timeout — the composable behind "You will be signed out in 30 seconds".
`useAuth` has no inactivity policy today, so this is wanted on its own merits
and not only as an exercise.

It is the smallest piece of real work in this boilerplate that needs all three
rules in [`docs/composable-design-rules.md`](./composable-design-rules.md) at
once:

- It must not run a timer during SSR (rules 1 and 3). A `setTimeout` armed in a
  render holds that request's closure until it fires, long after the response
  was flushed.
- It is untestable at an exact instant unless the clock, the scheduler and the
  activity source are arguments rather than globals (rule 2).
- Its state is per-caller scratch state, so a plain `ref` inside the composable
  is correct and `useState` would be wrong.

That makes it a kata about this repository's conventions rather than a kata
about `setTimeout`.

---

## Step 1 — red

**Commit:** `test: specify useIdleTimeout before writing it (kata step 1 — red)`
**Files:** `tests/unit/composables/useIdleTimeout.test.ts` (new)
**State:** `pnpm test` fails. So do `pnpm typecheck` and `pnpm lint`, on the
unresolved import.

```
Error: Failed to load url ../../../composables/useIdleTimeout
  (resolved id: ../../../composables/useIdleTimeout) in
  tests/unit/composables/useIdleTimeout.test.ts. Does the file exist?
Serialized Error: { code: 'ERR_MODULE_NOT_FOUND' }

 Test Files  1 failed (1)
      Tests  no tests
```

A module-not-found is the first failure of every honest TDD session and it is
worth not skipping past: it is the step that proves the test file is actually
being collected. A spec that is never run is indistinguishable from a spec that
passes.

The spec was written as the contract a caller wants, not as a description of
the implementation that would satisfy it:

- three phases, `active → warning → idle`, with `onWarn`/`onIdle`/`onActive`
  fired on transitions only — never on a tick that changed nothing
- `remaining`, refreshed once per `tick` through the warning window, so a
  countdown in a banner has something to bind to
- idle is terminal: no further wake is armed, and a late `activity()` does not
  silently revive the session
- activity postpones idling by a full timeout from the **last** event, including
  when the wake that was already armed lands before that
- **no extra timer per activity event**: 50 `pointermove` events must still leave
  exactly one armed timer
- `pause`/`resume`/`stop`, disposal with the surrounding effect scope, and an
  `enabled: false` mode that attaches and arms nothing — the SSR switch
- option validation for `timeout`, `warnAfter` and `tick`

### The assertion that did the design work

One of those is not a behaviour a user could notice. It is a design constraint,
written as a test:

```ts
it('arms no extra timer per activity event while active', () => {
  const { clock, dom } = setup()

  expect(clock.armed()).toBe(1)

  for (let i = 0; i < 50; i += 1) dom.fire('pointermove')

  expect(clock.armed()).toBe(1)
  expect(clock.pending()).toBe(1)
})
```

The obvious implementation of an idle timeout is `clearTimeout` plus
`setTimeout` on every activity event. It passes every **other** test in the
file. It fails this one, because `pointermove` fires at the pointer's sampling
rate and each event would destroy and rebuild a timer.

Making that assertion pass requires a different shape: record a timestamp on
activity, and have the wake re-derive the phase from the clock when it fires.
Which then makes a second test pass for free — `re-derives the phase from the
clock when a wake lands early`, where a wake armed before the last activity
must re-arm itself rather than announce a warning.

That is the part of TDD that is hard to show in a finished file. The design is
not in the implementation; it is in the test that rejected the easier one.

### The fake clock

Nothing here uses `vi.useFakeTimers()`. The spec injects a clock:

```ts
const idle = useIdleTimeout(options, {
  now: clock.now,
  schedule: clock.schedule,
  target: dom.target,
})
```

`advance` walks the timer queue in due order rather than firing everything
inside the window, because the composable arms its next wake from inside a
wake. Firing out of order would let a timer observe a clock reading from after
the moment it was due — and a spec that asserts exact instants cannot afford
that.

Patching the global would have worked too. It would have tested that a global
can be replaced, not that the composable has a seam.

---

## Step 2 — green

**Commit:** `feat: useIdleTimeout, the simplest thing that passes (kata step 2 — green)`
**Files:** `composables/useIdleTimeout.ts` (new, 252 lines)
**State:** 32 of 32 green. Whole suite 2,147 passing. `typecheck`, `lint`,
`format:check` clean.

The implementation does what step 1 forced and nothing else. The core of it was
a single function:

```ts
/** Reads the clock, moves to the phase it implies, and arms the next wake. */
function wake(): void {
  const elapsed = now() - lastActivity
  cancelPendingWake()

  if (elapsed >= timeout) {
    remaining.value = 0
    announce('idle')
    return
  }

  remaining.value = timeout - elapsed

  if (warnAfter === undefined) {
    announce('active')
    cancelWake = schedule(wake, timeout - elapsed)
    return
  }

  if (elapsed < warnAfter) {
    announce('active')
    cancelWake = schedule(wake, warnAfter - elapsed)
    return
  }

  announce('warning')
  cancelWake = schedule(wake, tick)
}
```

It is correct against the spec and it is green, and both of the things wrong
with it are structural rather than behavioural:

1. The elapsed-to-phase arithmetic appears four times, once per branch, so
   there is no single place where the state machine is written down.
2. It is reachable only through a timer. To ask "what happens when `elapsed` is
   exactly `warnAfter`?" you have to drive a whole composable to that instant.

The second one is why the bug below survived this step. **Resisting the urge to
tidy up here is part of the exercise**: the green step's job is to make the
spec pass so that the refactor has a safety net, and a refactor without a
passing spec behind it is just editing.

---

## Step 3 — refactor

**Commit:** `refactor: extract planIdleStep, which found a real bug (kata step 3)`
**Files:** `utils/idleTimer.ts` (new), `composables/useIdleTimeout.ts`
(252 → 225 lines), `tests/unit/utils/idleTimer.test.ts` (new),
`tests/unit/composables/useIdleTimeout.test.ts` (+1 case)
**State:** the 32 cases from step 1 unchanged and still green. Whole suite
2,179 passing.

The state machine became one pure function of elapsed time:

```ts
export function planIdleStep(elapsed: number, timing: IdleTiming): IdleStep {
  const since = Math.max(0, elapsed)
  const remaining = Math.max(0, timing.timeout - since)

  if (remaining === 0) {
    return { phase: 'idle', remaining: 0, delay: null }
  }

  if (timing.warnAfter === null) {
    return { phase: 'active', remaining, delay: remaining }
  }

  if (since < timing.warnAfter) {
    return { phase: 'active', remaining, delay: timing.warnAfter - since }
  }

  return { phase: 'warning', remaining, delay: Math.min(timing.tick, remaining) }
}
```

and the composable became the shell around it — own the clock, the listeners
and the refs, and otherwise do as it is told:

```ts
function wake(): void {
  cancelPendingWake()

  const step = planIdleStep(now() - lastActivity, timing)
  remaining.value = step.remaining
  announce(step.phase)

  if (step.delay !== null) cancelWake = schedule(wake, step.delay)
}
```

Validation moved out too, into `normalizeIdleTiming`, which runs once at
construction. That is what lets `planIdleStep` be total: every `IdleTiming` it
can be handed is already coherent, so it has no validation branches and no way
to fail.

### What the refactor bought: a real bug

A pure function can be asked about an instant without a timer, so
`tests/unit/utils/idleTimer.test.ts` walks the boundaries the composable spec
could not reach — `elapsed` exactly at `warnAfter`, exactly at `timeout`, a
negative elapsed from a clock that went backwards, and a `tick` longer than the
time actually left.

The last one was wrong. Step 2's final line armed the next wake a whole `tick`
ahead. With `timeout: 10_000`, `warnAfter: 6_000` and `tick: 3_000`, the wakes
land at 6,000 and 9,000 and then **12,000** — so a session the policy had ended
stayed open for two more seconds, and `onIdle` fired late by up to a whole tick.
For an auto-sign-out that is the difference between a policy and a suggestion.

Nothing in step 1's spec caught it, because the spec happened to use a `tick`
that divided the warning window exactly. Nothing was going to catch it while
the arithmetic was only reachable through a timer.

The fix is `Math.min(tick, remaining)`, guarded at both levels:

```ts
it('shortens the last wake so the tick cannot overshoot the timeout', () => {
  expect(planIdleStep(9_500, WARNED)).toEqual({ phase: 'warning', remaining: 500, delay: 500 })
})
```

```ts
it('still goes idle at exactly the timeout', () => {
  const { idle, clock, onIdle } = setup({ tick: 3_000 })

  clock.advance(TIMEOUT - 1)
  expect(idle.phase.value).toBe('warning')
  expect(onIdle).not.toHaveBeenCalled()

  clock.advance(1)
  expect(idle.phase.value).toBe('idle')
  expect(onIdle).toHaveBeenCalledTimes(1)
})
```

That second one was checked against the failure it names, rather than assumed
to have teeth: restoring step 2's `composables/useIdleTimeout.ts` over the
refactored one and re-running the spec fails exactly that case —
`AssertionError: expected 'warning' to be 'idle'` — and leaves the other 32
passing. Try it yourself:

```sh
git show <step-2-sha>:composables/useIdleTimeout.ts > composables/useIdleTimeout.ts
npx vitest run tests/unit/composables/useIdleTimeout.test.ts
# 1 failed | 32 passed (33)
git checkout composables/useIdleTimeout.ts
```

### And two invariants

Being a function also makes a property worth asserting cheaply. Across every
millisecond from -500 to `timeout` + 500, for three different timings:

- a wake is never armed past the timeout, and every `delay` is positive
- `phase === 'idle'` exactly when `remaining === 0`

Which is the other thing the refactor bought: the next person to change the
state machine cannot quietly reintroduce the same **shape** of bug, not just
the same bug.

---

## What the kata does not show

Worth stating plainly, because a worked example trusted beyond its reach is
worse than none:

- **Three commits is one cycle, not a session.** Real TDD on something this
  size is many red→green→refactor loops, each a few lines wide. This is one
  loop, written out, because `SPEC.md` asked for one commit per step and
  because a thirty-commit kata is not a document anyone reads.
- **Step 1's spec is the whole contract at once.** Doctrine is one failing test
  at a time. Writing all of it up front is what made the bug in step 2
  survivable — the spec that was going to catch a `tick` boundary was never
  written, and no amount of discipline about commit size would have changed
  that.
- **It is a reconstruction, not a recording.** The commits are real, in order,
  and each was run against the gates at the state its message claims. But the
  design arguments in it were had before the first line of the spec was typed,
  not discovered live.
- **Nothing here is about `.vue` files.** The kata is deliberately a composable:
  the hard part of testing a component is the mount, and that is
  [`@nuxt/test-utils`](https://nuxt.com/docs/getting-started/testing)' problem,
  not TDD's.

## The gate on this document

`tests/unit/lint/tdd-kata.test.ts` fails `pnpm test` if this file stops
matching the repository: a step heading renamed, a file path that no longer
exists, or a test name quoted here that is no longer in the spec. A worked
example that has drifted from the code teaches the drift.

What it cannot check is whether the prose is still _true_ — that is what
reading it is for.
