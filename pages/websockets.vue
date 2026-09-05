<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { useWsChannel } from '~/composables/useWsChannel'
import type { ApiResponse } from '~/types/api'
import { WS_TICKET_SUBPROTOCOL, type WsServerFrame, type WsTicketResponse } from '~/types/websocket'

definePageMeta({ layout: false })

// ─── The channel ─────────────────────────────────────────────────────────────
// One composable. It fetches a ticket, opens the socket, and reconnects — a
// fresh ticket per attempt, because a ticket is spent on first use.

const { status, frames, identity, error, attempts, connect, disconnect, send } =
  useWsChannel('echo')

onMounted(connect)

const draft = ref('Hello from the browser')

function sendEcho(): void {
  if (draft.value === '') return
  send({ type: 'echo', text: draft.value })
}

const statusTone = computed(() => {
  switch (status.value) {
    case 'connected':
      return 'bg-green-500'
    case 'connecting':
      return 'bg-amber-500'
    case 'error':
      return 'bg-red-500'
    default:
      return 'bg-[var(--color-muted-foreground)]'
  }
})

function describeFrame(frame: WsServerFrame): string {
  switch (frame.type) {
    case 'welcome':
      return `authenticated as ${frame.userId} — peer ${frame.peerId}`
    case 'echoed':
      return `#${frame.seq} ${frame.text}`
    case 'pong':
      return `keepalive${frame.nonce ? ` (${frame.nonce})` : ''} at ${new Date(frame.at).toLocaleTimeString()}`
    case 'identity':
      return `${frame.userId} on ${frame.channel}, ticket ${frame.ticketId}`
    case 'error':
      return frame.message
  }
}

// ─── The failure modes, run on purpose ───────────────────────────────────────
// Every one of these is silent from the client's side — a refused upgrade
// reaches JavaScript as an `error` event with no status and a close code of
// 1006. What the demo can show is the *outcome*, which is the point: this is
// what the failures look like from where you would be debugging them.

interface Probe {
  readonly id: string
  readonly label: string
  readonly detail: string
  readonly run: () => Promise<string>
}

const probeResults = ref<Record<string, string>>({})
const probing = ref<string | null>(null)

async function mintTicket(): Promise<WsTicketResponse> {
  const response = await $fetch<ApiResponse<WsTicketResponse>>('/api/ws/ticket', {
    method: 'POST',
    body: { channel: 'echo' },
  })
  return response.data
}

function wsUrl(query = ''): string {
  const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${scheme}//${window.location.host}/api/ws/echo${query}`
}

/** Opens a socket and reports whether the handshake was accepted. */
function attempt(url: string, protocols?: string[]): Promise<'opened' | 'refused'> {
  return new Promise((resolve) => {
    const socket = protocols ? new WebSocket(url, protocols) : new WebSocket(url)
    socket.addEventListener('open', () => {
      socket.close()
      resolve('opened')
    })
    socket.addEventListener('error', () => resolve('refused'))
  })
}

const PROBES: readonly Probe[] = [
  {
    id: 'no-ticket',
    label: 'Connect with no ticket',
    detail:
      'The session cookie is attached to this handshake by the browser. It is not what admits the socket — that is the whole defence against cross-site hijacking.',
    run: async () => {
      const outcome = await attempt(wsUrl())
      return outcome === 'refused'
        ? 'Refused (401 in the network panel).'
        : 'Opened — that is a bug.'
    },
  },
  {
    id: 'replay',
    label: 'Reuse one ticket twice',
    detail:
      'A ticket is spent on the first handshake. This is what makes a ticket in a URL survivable when the URL reaches an access log.',
    run: async () => {
      const ticket = await mintTicket()
      const first = await attempt(wsUrl(`?ticket=${encodeURIComponent(ticket.token)}`))
      const second = await attempt(wsUrl(`?ticket=${encodeURIComponent(ticket.token)}`))
      return `First: ${first}. Second: ${second}.`
    },
  },
  {
    id: 'forged',
    label: 'Connect with a forged ticket',
    detail:
      'Well-formed, wrong signature. The server distinguishes this from an expired one in its log and tells the client nothing — the difference would be an oracle.',
    run: async () => {
      const outcome = await attempt(wsUrl('?ticket=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.forged'))
      return outcome === 'refused'
        ? 'Refused, identically to every other bad ticket.'
        : 'Opened — that is a bug.'
    },
  },
  {
    id: 'subprotocol',
    label: 'Connect over the subprotocol',
    detail:
      'The transport that keeps the credential out of the URL. The marker goes first because the server selects the first protocol offered, and the 101 echoes it.',
    run: async () => {
      const ticket = await mintTicket()
      const outcome = await attempt(wsUrl(), [WS_TICKET_SUBPROTOCOL, ticket.token])
      return outcome === 'opened' ? 'Opened, with the token never in the URL.' : 'Refused.'
    },
  },
  {
    id: 'oversized',
    label: 'Send a frame over 16 KiB',
    detail:
      'A socket can send frames until it is closed, so the cap is per frame and enforced in bytes.',
    run: () =>
      new Promise((resolve) => {
        void mintTicket().then((ticket) => {
          const socket = new WebSocket(wsUrl(), [WS_TICKET_SUBPROTOCOL, ticket.token])
          socket.addEventListener('open', () => {
            socket.send(JSON.stringify({ type: 'echo', text: 'x'.repeat(20_000) }))
          })
          socket.addEventListener('close', (event) => {
            resolve(`Closed with ${event.code}${event.reason ? ` — ${event.reason}` : ''}.`)
          })
          socket.addEventListener('error', () => resolve('Handshake refused.'))
        })
      }),
  },
]

async function runProbe(probe: Probe): Promise<void> {
  probing.value = probe.id
  try {
    probeResults.value = { ...probeResults.value, [probe.id]: await probe.run() }
  } catch {
    probeResults.value = {
      ...probeResults.value,
      [probe.id]: 'The ticket route refused the request.',
    }
  } finally {
    probing.value = null
  }
}
</script>

<template>
  <div class="min-h-screen bg-[var(--color-background)] p-6">
    <div class="mx-auto max-w-3xl space-y-8">
      <header>
        <h1 class="text-2xl font-bold text-[var(--color-foreground)]">WebSockets</h1>
        <p class="mt-1 text-sm text-[var(--color-muted-foreground)]">
          A WebSocket handshake is exempt from the same-origin policy, so any page anywhere can open
          one to this app and the browser will send this app's cookies with it. The socket is
          admitted by a short-lived, single-use ticket instead — see
          <code>docs/websockets.md</code>.
        </p>
      </header>

      <!-- ── The connection ── -->
      <section class="rounded-xl border border-[var(--color-border)] bg-[var(--color-muted)] p-6">
        <div class="flex items-center justify-between gap-4">
          <h2 class="text-lg font-semibold text-[var(--color-foreground)]">The echo channel</h2>
          <span class="flex items-center gap-2 text-xs text-[var(--color-muted-foreground)]">
            <span class="size-2 rounded-full" :class="statusTone" />
            {{ status }}<template v-if="attempts > 0"> · attempt {{ attempts }}</template>
          </span>
        </div>

        <p class="mt-0.5 text-xs text-[var(--color-muted-foreground)]">
          <code>useWsChannel('echo')</code> — the status reads <code>connected</code> only once the
          server's <code>welcome</code> frame arrives. <code>onopen</code> proves the handshake
          finished, not who the server thinks you are.
        </p>

        <dl
          v-if="identity"
          class="mt-4 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-[var(--color-foreground)]"
        >
          <dt class="text-[var(--color-muted-foreground)]">User</dt>
          <dd>
            <code>{{ identity.userId }}</code>
          </dd>
          <dt class="text-[var(--color-muted-foreground)]">Peer</dt>
          <dd>
            <code>{{ identity.peerId }}</code>
          </dd>
          <dt class="text-[var(--color-muted-foreground)]">Session expires</dt>
          <dd>{{ new Date(identity.sessionExpiresAt).toLocaleString() }}</dd>
        </dl>

        <p v-if="error" class="mt-4 rounded-md bg-red-500/10 px-3 py-2 text-xs text-red-500">
          {{ error }}
        </p>

        <div class="mt-4 flex flex-wrap gap-2">
          <input
            v-model="draft"
            type="text"
            placeholder="Say something…"
            class="min-w-48 flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-background)] px-3 py-2 text-sm text-[var(--color-foreground)] focus:ring-2 focus:ring-[var(--color-primary)] focus:outline-none"
            @keyup.enter="sendEcho"
          />
          <button
            type="button"
            class="rounded-md bg-[var(--color-primary)] px-3 py-2 text-sm font-medium text-[var(--color-primary-foreground)] disabled:opacity-50"
            :disabled="status !== 'connected'"
            @click="sendEcho"
          >
            Echo
          </button>
          <button
            type="button"
            class="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-foreground)] disabled:opacity-50"
            :disabled="status !== 'connected'"
            @click="send({ type: 'whoami' })"
          >
            Who am I?
          </button>
          <button
            v-if="status === 'connected' || status === 'connecting'"
            type="button"
            class="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-foreground)]"
            @click="disconnect"
          >
            Disconnect
          </button>
          <button
            v-else
            type="button"
            class="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-foreground)]"
            @click="connect"
          >
            Connect
          </button>
        </div>

        <ul class="mt-4 max-h-64 space-y-1 overflow-y-auto font-mono text-xs">
          <li
            v-for="(frame, index) in frames"
            :key="index"
            class="flex gap-2 rounded bg-[var(--color-background)] px-2 py-1"
          >
            <span class="shrink-0 text-[var(--color-primary)]">{{ frame.type }}</span>
            <span class="text-[var(--color-muted-foreground)]">{{ describeFrame(frame) }}</span>
          </li>
          <li v-if="frames.length === 0" class="px-2 py-1 text-[var(--color-muted-foreground)]">
            No frames yet.
          </li>
        </ul>
      </section>

      <!-- ── The failures ── -->
      <section class="rounded-xl border border-[var(--color-border)] bg-[var(--color-muted)] p-6">
        <h2 class="text-lg font-semibold text-[var(--color-foreground)]">
          The refusals, run on purpose
        </h2>
        <p class="mt-0.5 text-xs text-[var(--color-muted-foreground)]">
          A rejected upgrade reaches JavaScript as an <code>error</code> event with no status and a
          close code of <code>1006</code>. The status is in the network panel and the reason is in
          the server log — which is exactly why these are worth running once.
        </p>

        <ul class="mt-4 space-y-3">
          <li
            v-for="probe in PROBES"
            :key="probe.id"
            class="rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] p-3"
          >
            <div class="flex items-start justify-between gap-3">
              <div>
                <p class="text-sm font-medium text-[var(--color-foreground)]">{{ probe.label }}</p>
                <p class="mt-0.5 text-xs text-[var(--color-muted-foreground)]">
                  {{ probe.detail }}
                </p>
              </div>
              <button
                type="button"
                class="shrink-0 rounded-md border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-foreground)] disabled:opacity-50"
                :disabled="probing !== null"
                @click="runProbe(probe)"
              >
                {{ probing === probe.id ? 'Running…' : 'Run' }}
              </button>
            </div>
            <p
              v-if="probeResults[probe.id]"
              class="mt-2 font-mono text-xs text-[var(--color-primary)]"
            >
              {{ probeResults[probe.id] }}
            </p>
          </li>
        </ul>
      </section>
    </div>
  </div>
</template>
