<script setup lang="ts">
definePageMeta({ layout: false })

const { t } = useI18n()
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
          <h1 class="text-2xl font-bold text-[var(--color-foreground)]">
            {{ t('dashboard.title') }}
          </h1>
          <button
            class="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2"
            @click="handleLogout"
          >
            {{ t('common.signOut') }}
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
              <span class="font-medium">{{ t('dashboard.name') }}: </span>{{ user.name }}
            </p>
            <p class="text-[var(--color-foreground)]">
              <span class="font-medium">{{ t('dashboard.email') }}: </span>
              {{ user.email || t('dashboard.noEmail') }}
            </p>
            <p class="text-[var(--color-foreground)]">
              <span class="font-medium">{{ t('dashboard.provider') }}: </span>
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
          {{ t('counter.title') }}
          <span class="ml-2 text-xs font-normal text-[var(--color-muted-foreground)]">
            {{ t('counter.subtitle') }}
          </span>
        </h2>

        <div class="flex items-center gap-4">
          <span class="text-4xl font-bold text-[var(--color-primary)]">{{ counter.count }}</span>
          <div class="space-y-1 text-sm text-[var(--color-muted-foreground)]">
            <p>{{ t('counter.doubled', { value: counter.doubled }) }}</p>
            <p>{{ t('counter.positive', { value: counter.isPositive }) }}</p>
          </div>
        </div>

        <div class="flex gap-2">
          <button
            class="rounded-md bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-[var(--color-primary-foreground)] hover:opacity-90"
            @click="counter.increment()"
          >
            {{ t('counter.increment') }}
          </button>
          <button
            class="rounded-md border border-[var(--color-border)] bg-[var(--color-background)] px-4 py-2 text-sm font-medium text-[var(--color-foreground)] hover:bg-[var(--color-muted)]"
            @click="counter.decrement()"
          >
            {{ t('counter.decrement') }}
          </button>
          <button
            class="rounded-md border border-[var(--color-border)] bg-[var(--color-background)] px-4 py-2 text-sm font-medium text-[var(--color-foreground)] hover:bg-[var(--color-muted)]"
            @click="counter.reset()"
          >
            {{ t('counter.reset') }}
          </button>
        </div>

        <p v-if="counter.lastUpdated" class="text-xs text-[var(--color-muted-foreground)]">
          {{ t('counter.lastUpdated', { time: counter.lastUpdated }) }}
        </p>
      </div>

      <!-- Preferences store demo -->
      <div
        class="rounded-xl border border-[var(--color-border)] bg-[var(--color-muted)] p-6 space-y-4"
      >
        <h2 class="text-lg font-semibold text-[var(--color-foreground)]">
          {{ t('preferences.title') }}
          <span class="ml-2 text-xs font-normal text-[var(--color-muted-foreground)]">
            {{ t('preferences.subtitle') }}
          </span>
        </h2>

        <div class="grid grid-cols-2 gap-4 text-sm">
          <div>
            <label class="block font-medium text-[var(--color-foreground)] mb-1">
              {{ t('preferences.colorMode') }}
            </label>
            <div class="space-y-2">
              <ColorModeToggle variant="segmented" />
              <p class="text-xs text-[var(--color-muted-foreground)]">
                {{ t('preferences.activeMode', { mode: isDark ? 'dark' : 'light' }) }}
                · {{ t('preferences.preferenceMode', { pref: colorPreference }) }}
              </p>
            </div>
          </div>

          <div>
            <label class="block font-medium text-[var(--color-foreground)] mb-1">
              {{ t('preferences.sidebar') }}
            </label>
            <button
              class="rounded px-3 py-1 text-xs font-medium border border-[var(--color-border)] bg-[var(--color-background)] text-[var(--color-foreground)]"
              @click="preferences.toggleSidebar()"
            >
              {{ preferences.isSidebarOpen ? t('preferences.closeSidebar') : t('preferences.openSidebar') }}
            </button>
          </div>

          <div>
            <label class="block font-medium text-[var(--color-foreground)] mb-1">
              {{ t('preferences.language') }}
            </label>
            <LanguageSwitcher />
          </div>

          <div>
            <label class="block font-medium text-[var(--color-foreground)] mb-1">
              {{ t('preferences.pageSize') }}
            </label>
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
