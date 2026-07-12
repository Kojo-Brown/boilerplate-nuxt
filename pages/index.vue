<script setup lang="ts">
definePageMeta({ layout: false })

const { user, clear } = useUserSession()

async function handleLogout() {
  await clear()
  await navigateTo('/login')
}

const counter = useCounterStore()
const preferences = usePreferencesStore()
const { isDark, preference: colorPreference } = useAppColorMode()
</script>

<template>
  <div class="min-h-screen bg-[var(--color-background)] p-8">
    <div class="mx-auto max-w-2xl space-y-6">
      <!-- User card -->
      <div
        class="space-y-6 rounded-xl border border-[var(--color-border)] bg-[var(--color-muted)] p-6"
      >
        <div class="flex items-center justify-between">
          <h1 class="text-2xl font-bold text-[var(--color-foreground)]">Dashboard</h1>
          <button
            class="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2"
            @click="handleLogout"
          >
            Sign out
          </button>
        </div>

        <div v-if="user" class="space-y-3">
          <div v-if="user.avatarUrl" class="flex items-center gap-4">
            <img
              :src="user.avatarUrl"
              :alt="`${user.name} avatar`"
              class="h-14 w-14 rounded-full ring-2 ring-[var(--color-border)]"
            />
            <div>
              <p class="text-lg font-semibold text-[var(--color-foreground)]">{{ user.name }}</p>
              <p class="text-sm text-[var(--color-muted-foreground)]">@{{ user.login }}</p>
            </div>
          </div>

          <div class="space-y-2 text-sm">
            <p class="text-[var(--color-foreground)]">
              <span class="font-medium">Name: </span>{{ user.name }}
            </p>
            <p class="text-[var(--color-foreground)]">
              <span class="font-medium">Email: </span>{{ user.email || '—' }}
            </p>
            <p class="text-[var(--color-foreground)]">
              <span class="font-medium">Provider: </span>
              <span
                class="ml-1 inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium"
                :class="
                  user.provider === 'github'
                    ? 'bg-gray-900 text-white dark:bg-white dark:text-gray-900'
                    : 'bg-[var(--color-primary)] text-[var(--color-primary-foreground)]'
                "
              >
                {{ user.provider }}
              </span>
            </p>
          </div>
        </div>
      </div>

      <!-- Counter store demo -->
      <div
        class="rounded-xl border border-[var(--color-border)] bg-[var(--color-muted)] p-6 space-y-4"
      >
        <h2 class="text-lg font-semibold text-[var(--color-foreground)]">
          Counter Store
          <span class="ml-2 text-xs font-normal text-[var(--color-muted-foreground)]">
            persisted to localStorage
          </span>
        </h2>

        <div class="flex items-center gap-4">
          <span class="text-4xl font-bold text-[var(--color-primary)]">{{ counter.count }}</span>
          <div class="space-y-1 text-sm text-[var(--color-muted-foreground)]">
            <p>Doubled: {{ counter.doubled }}</p>
            <p>Positive: {{ counter.isPositive }}</p>
          </div>
        </div>

        <div class="flex gap-2">
          <button
            class="rounded-md bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-[var(--color-primary-foreground)] hover:opacity-90"
            @click="counter.increment()"
          >
            +1
          </button>
          <button
            class="rounded-md border border-[var(--color-border)] bg-[var(--color-background)] px-4 py-2 text-sm font-medium text-[var(--color-foreground)] hover:bg-[var(--color-muted)]"
            @click="counter.decrement()"
          >
            −1
          </button>
          <button
            class="rounded-md border border-[var(--color-border)] bg-[var(--color-background)] px-4 py-2 text-sm font-medium text-[var(--color-foreground)] hover:bg-[var(--color-muted)]"
            @click="counter.reset()"
          >
            Reset
          </button>
        </div>

        <p v-if="counter.lastUpdated" class="text-xs text-[var(--color-muted-foreground)]">
          Last updated: {{ counter.lastUpdated }}
        </p>
      </div>

      <!-- Preferences store demo -->
      <div
        class="rounded-xl border border-[var(--color-border)] bg-[var(--color-muted)] p-6 space-y-4"
      >
        <h2 class="text-lg font-semibold text-[var(--color-foreground)]">
          Preferences Store
          <span class="ml-2 text-xs font-normal text-[var(--color-muted-foreground)]">
            persisted to localStorage
          </span>
        </h2>

        <div class="grid grid-cols-2 gap-4 text-sm">
          <div>
            <label class="block font-medium text-[var(--color-foreground)] mb-1">Color mode</label>
            <div class="space-y-2">
              <ColorModeToggle variant="segmented" />
              <p class="text-xs text-[var(--color-muted-foreground)]">
                Active: <span class="font-medium">{{ isDark ? 'dark' : 'light' }}</span>
                · Preference: <span class="font-medium">{{ colorPreference }}</span>
              </p>
            </div>
          </div>

          <div>
            <label class="block font-medium text-[var(--color-foreground)] mb-1">Sidebar</label>
            <button
              class="rounded px-3 py-1 text-xs font-medium border border-[var(--color-border)] bg-[var(--color-background)] text-[var(--color-foreground)]"
              @click="preferences.toggleSidebar()"
            >
              {{ preferences.isSidebarOpen ? 'Close sidebar' : 'Open sidebar' }}
            </button>
          </div>

          <div>
            <label class="block font-medium text-[var(--color-foreground)] mb-1">Language</label>
            <select
              class="rounded border border-[var(--color-border)] bg-[var(--color-background)] px-2 py-1 text-xs text-[var(--color-foreground)]"
              :value="preferences.language"
              @change="preferences.setLanguage(($event.target as HTMLSelectElement).value)"
            >
              <option value="en">English</option>
              <option value="fr">Français</option>
              <option value="es">Español</option>
            </select>
          </div>

          <div>
            <label class="block font-medium text-[var(--color-foreground)] mb-1">Page size</label>
            <select
              class="rounded border border-[var(--color-border)] bg-[var(--color-background)] px-2 py-1 text-xs text-[var(--color-foreground)]"
              :value="preferences.pageSize"
              @change="preferences.setPageSize(Number(($event.target as HTMLSelectElement).value))"
            >
              <option value="10">10</option>
              <option value="25">25</option>
              <option value="50">50</option>
              <option value="100">100</option>
            </select>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
