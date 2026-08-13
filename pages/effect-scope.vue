<script lang="ts">
import { computed, effectScope, onScopeDispose, ref, shallowRef, watch } from 'vue'
import type { ComputedRef, EffectScope, Ref } from 'vue'

/**
 * Everything in this block is module scope: it is evaluated once per module,
 * not once per component instance. That is exactly where a shared composable
 * belongs — declared next to the code that uses it, holding no mutable state
 * of its own. The state lives inside the detached effect scope, which is not
 * created until the first consumer subscribes and is destroyed when the last
 * one leaves. Nothing is allocated during SSR, because on the server nobody
 * ever clicks.
 */

export interface SharedSession {
  /** Random per instance, so a rebuilt instance is visibly a different one. */
  id: string
  ticks: Readonly<Ref<number>>
  status: ComputedRef<string>
}

/**
 * The canonical case for a detached scope: one interval, shared by every
 * consumer, owned by none of them.
 *
 * Written the usual way — a module-level `ref` and an interval started on
 * first use — the interval would belong to whichever component mounted first
 * and would keep firing after all of them had gone. Here it is created inside
 * the scope, and `onScopeDispose` hands it to the same teardown that collects
 * the watcher and the computed.
 */
const useSharedSession = createSharedComposable<SharedSession>(() => {
  const ticks = ref(0)

  const interval = setInterval(() => {
    ticks.value += 1
  }, 1_000)

  onScopeDispose(() => clearInterval(interval))

  return {
    id: Math.random().toString(36).slice(2, 8),
    ticks,
    status: computed(() => (ticks.value < 5 ? 'warming up' : 'steady')),
  }
})

interface ChannelView {
  generation: number
  channel: string
  received: Ref<number>
}
</script>

<script setup lang="ts">
definePageMeta({ layout: false })

const CHANNELS = ['alpha', 'beta', 'gamma'] as const
const FILTERS = ['all', 'errors', 'warnings'] as const

// ─── Event log ───────────────────────────────────────────────────────────────

const logs = ref<string[]>([])

function log(message: string): void {
  const stamp = new Date().toLocaleTimeString('en-GB', { hour12: false })
  logs.value = [`${stamp}  ${message}`, ...logs.value].slice(0, 12)
}

// ─── 1. Shared composable, refcounted teardown ───────────────────────────────
// Each "consumer" is a real `effectScope` standing in for a mounted component:
// it subscribes on creation and releases on `stop()`, which is precisely what a
// component does on unmount.

const consumerIds = ref<number[]>([])
/** Scopes are not reactive data — kept out of the ref so nothing proxies them. */
const consumerScopes = new Map<number, EffectScope>()
let nextConsumerId = 1

/**
 * The live shared value, mirrored so the page can render it without taking out
 * a subscription of its own — a page that subscribed would pin the instance
 * open and there would be nothing to demonstrate.
 */
const session = shallowRef<SharedSession | null>(null)

function mountConsumer(): void {
  const id = nextConsumerId++
  const scope = effectScope()

  scope.run(() => {
    // The subscription is registered against `scope`, so stopping it below is
    // the whole of the release.
    session.value = useSharedSession()
  })

  consumerScopes.set(id, scope)
  consumerIds.value = [...consumerIds.value, id]
  log(`consumer #${id} subscribed · instance ${session.value?.id ?? '—'}`)
}

function unmountConsumer(id: number): void {
  consumerScopes.get(id)?.stop()
  consumerScopes.delete(id)
  consumerIds.value = consumerIds.value.filter((c) => c !== id)

  if (useSharedSession.isActive()) {
    log(`consumer #${id} released · ${useSharedSession.consumers()} left, instance kept`)
  } else {
    session.value = null
    log(`consumer #${id} released · last one out, scope stopped and interval cleared`)
  }
}

const consumerCount = computed(() => consumerIds.value.length)

// The stand-in scopes are created from a click handler, so no scope adopts
// them and navigating away would leave the shared interval running. The page's
// own scope owns them instead.
onScopeDispose(() => {
  for (const scope of consumerScopes.values()) scope.stop()
  consumerScopes.clear()
})

// ─── 2. Restartable groups inside one component ──────────────────────────────
// `useScopedEffects` is owned by this component's scope, so everything below
// dies on navigation away — but each `run()` also disposes the group before it,
// which is the part a component scope alone will not do.

const scoped = useScopedEffects()
const filter = ref('all')
const history = shallowRef<ChannelView[]>([])

function subscribeChannel(channel: string): void {
  const view = scoped.run<ChannelView>(() => {
    const received = ref(0)

    const poll = setInterval(() => {
      received.value += 1
    }, 500)

    watch(filter, (next) => log(`[${channel}] filter → ${next}`))

    onScopeDispose(() => {
      clearInterval(poll)
      log(`[${channel}] group disposed · interval and watcher collected`)
    })

    return { generation: scoped.generation.value, channel, received }
  })

  history.value = [view, ...history.value].slice(0, 4)
  log(`[${channel}] subscribed · generation ${view.generation}`)
}

function unsubscribeChannel(): void {
  if (!scoped.isActive.value) return
  scoped.stop()
}

const liveGeneration = computed(() => (scoped.isActive.value ? scoped.generation.value : null))
</script>

<template>
  <div class="min-h-screen bg-[var(--color-background)] p-6">
    <div class="mx-auto max-w-3xl space-y-8">
      <header>
        <h1 class="text-2xl font-bold text-[var(--color-foreground)]">Grouped Teardown</h1>
        <p class="mt-1 text-sm text-[var(--color-muted-foreground)]">
          <code>effectScope</code> gives a set of effects one owner and one <code>stop()</code> —
          for state that must outlive the component that created it, and for effects that must not
          outlive the selection that created them.
        </p>
      </header>

      <!-- ── 1. Shared composable ── -->
      <section class="rounded-xl border border-[var(--color-border)] bg-[var(--color-muted)] p-6">
        <h2 class="text-lg font-semibold text-[var(--color-foreground)]">
          Shared composable, refcounted
        </h2>
        <p class="mt-0.5 text-xs text-[var(--color-muted-foreground)]">
          One interval for every consumer. Subscribe from several scopes, then release them one at a
          time: the instance survives until the last release, and the next subscribe builds a new
          one from zero.
        </p>

        <div class="mt-4 grid gap-4 sm:grid-cols-2">
          <div
            class="rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] p-4"
          >
            <p class="text-xs text-[var(--color-muted-foreground)]">Shared instance</p>
            <p v-if="session" class="mt-1 font-mono text-2xl font-bold text-[var(--color-primary)]">
              {{ session.ticks.value }}s
            </p>
            <p
              v-else
              class="mt-1 font-mono text-2xl font-bold text-[var(--color-muted-foreground)]"
            >
              —
            </p>
            <p class="mt-1 text-xs text-[var(--color-muted-foreground)]">
              <template v-if="session">
                id <code>{{ session.id }}</code> · {{ session.status.value }}
              </template>
              <template v-else>no instance — nothing is running</template>
            </p>
          </div>

          <div
            class="rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] p-4"
          >
            <p class="text-xs text-[var(--color-muted-foreground)]">Consumers</p>
            <p class="mt-1 font-mono text-2xl font-bold text-[var(--color-foreground)]">
              {{ consumerCount }}
            </p>
            <p class="mt-1 text-xs text-[var(--color-muted-foreground)]">
              scope active: {{ session ? 'yes' : 'no' }}
            </p>
          </div>
        </div>

        <div class="mt-4 flex flex-wrap items-center gap-2">
          <button
            class="rounded-md bg-[var(--color-primary)] px-3 py-1.5 text-xs font-medium text-[var(--color-primary-foreground)] hover:opacity-90"
            @click="mountConsumer()"
          >
            Subscribe a consumer
          </button>
          <button
            v-for="id in consumerIds"
            :key="id"
            class="rounded-md border border-[var(--color-border)] bg-[var(--color-background)] px-3 py-1.5 text-xs font-medium text-[var(--color-foreground)] hover:bg-[var(--color-muted)]"
            @click="unmountConsumer(id)"
          >
            Release #{{ id }}
          </button>
        </div>
      </section>

      <!-- ── 2. Restartable groups ── -->
      <section class="rounded-xl border border-[var(--color-border)] bg-[var(--color-muted)] p-6">
        <h2 class="text-lg font-semibold text-[var(--color-foreground)]">
          Restartable groups in one component
        </h2>
        <p class="mt-0.5 text-xs text-[var(--color-muted-foreground)]">
          Each subscribe builds an interval and a watcher inside a fresh group. Switch channels and
          the counters below freeze one by one — a component scope would have kept every one of them
          running until unmount.
        </p>

        <div class="mt-4 flex flex-wrap gap-2">
          <button
            v-for="channel in CHANNELS"
            :key="channel"
            class="rounded-md bg-[var(--color-primary)] px-3 py-1.5 text-xs font-medium text-[var(--color-primary-foreground)] hover:opacity-90"
            @click="subscribeChannel(channel)"
          >
            Subscribe {{ channel }}
          </button>
          <button
            class="rounded-md border border-[var(--color-border)] bg-[var(--color-background)] px-3 py-1.5 text-xs font-medium text-[var(--color-foreground)] hover:bg-[var(--color-muted)] disabled:opacity-40"
            :disabled="!scoped.isActive.value"
            @click="unsubscribeChannel()"
          >
            Stop current
          </button>
        </div>

        <div class="mt-4 flex flex-wrap items-center gap-2">
          <span class="text-xs text-[var(--color-muted-foreground)]">Filter:</span>
          <button
            v-for="option in FILTERS"
            :key="option"
            class="rounded-md border px-2.5 py-1 text-xs font-medium"
            :class="
              filter === option
                ? 'border-transparent bg-[var(--color-foreground)] text-[var(--color-background)]'
                : 'border-[var(--color-border)] bg-[var(--color-background)] text-[var(--color-foreground)] hover:bg-[var(--color-muted)]'
            "
            @click="filter = option"
          >
            {{ option }}
          </button>
          <span class="text-xs text-[var(--color-muted-foreground)]">
            only the live group logs a change
          </span>
        </div>

        <ul v-if="history.length" class="mt-4 space-y-2">
          <li
            v-for="view in history"
            :key="view.generation"
            class="flex items-center justify-between rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] px-4 py-2"
          >
            <span class="text-sm text-[var(--color-foreground)]">
              gen {{ view.generation }} · <code>{{ view.channel }}</code>
            </span>
            <span class="flex items-center gap-3">
              <span class="font-mono text-sm text-[var(--color-foreground)]">
                {{ view.received.value }} msg
              </span>
              <span
                class="rounded-full px-2 py-0.5 text-xs font-medium"
                :class="
                  view.generation === liveGeneration
                    ? 'bg-[var(--color-primary)] text-[var(--color-primary-foreground)]'
                    : 'bg-[var(--color-muted)] text-[var(--color-muted-foreground)]'
                "
              >
                {{ view.generation === liveGeneration ? 'live' : 'stopped' }}
              </span>
            </span>
          </li>
        </ul>
        <p v-else class="mt-4 text-xs text-[var(--color-muted-foreground)]">
          No group yet. Subscribe to a channel.
        </p>
      </section>

      <!-- ── Log ── -->
      <section class="rounded-xl border border-[var(--color-border)] bg-[var(--color-muted)] p-6">
        <h2 class="text-lg font-semibold text-[var(--color-foreground)]">Lifecycle log</h2>
        <ul v-if="logs.length" class="mt-3 space-y-1">
          <li
            v-for="(entry, i) in logs"
            :key="`${entry}-${i}`"
            class="font-mono text-xs text-[var(--color-muted-foreground)]"
          >
            {{ entry }}
          </li>
        </ul>
        <p v-else class="mt-3 text-xs text-[var(--color-muted-foreground)]">
          Nothing yet. Subscribe to something above.
        </p>
      </section>
    </div>
  </div>
</template>
