<script setup lang="ts">
definePageMeta({ layout: false })

const { user, loggedIn, clear } = useUserSession()

if (!loggedIn.value) {
  await navigateTo('/login')
}

async function handleLogout() {
  await clear()
  await navigateTo('/login')
}
</script>

<template>
  <div class="min-h-screen bg-[var(--color-background)] p-8">
    <div class="mx-auto max-w-2xl">
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
          <div
            v-if="user.avatarUrl"
            class="flex items-center gap-4"
          >
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
    </div>
  </div>
</template>
