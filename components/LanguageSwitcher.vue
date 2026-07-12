<script setup lang="ts">
const { locale, locales, setLocale } = useI18n()

const availableLocales = computed(() =>
  locales.value.filter((l) => typeof l === 'object' && 'code' in l),
)

async function switchLocale(code: string) {
  await setLocale(code)
}
</script>

<template>
  <div class="relative inline-flex items-center gap-1">
    <label
      for="language-select"
      class="sr-only"
    >{{ $t('common.language') }}</label>
    <select
      id="language-select"
      :value="locale"
      class="appearance-none rounded-md border border-[var(--color-border)] bg-[var(--color-background)] py-1.5 pl-3 pr-8 text-sm text-[var(--color-foreground)] shadow-sm transition-colors hover:border-[var(--color-primary)] focus:border-[var(--color-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--color-primary)]"
      @change="switchLocale(($event.target as HTMLSelectElement).value)"
    >
      <option
        v-for="loc in availableLocales"
        :key="loc.code"
        :value="loc.code"
      >
        {{ loc.name }}
      </option>
    </select>
    <span
      class="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[var(--color-muted-foreground)]"
      aria-hidden="true"
    >
      ▾
    </span>
  </div>
</template>
