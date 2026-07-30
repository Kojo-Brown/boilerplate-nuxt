<script setup lang="ts">
const { locale, locales, setLocale } = useI18n()

const availableLocales = computed(() =>
  locales.value.filter((l) => typeof l === 'object' && 'code' in l),
)

// The generated setLocale accepts only the configured locale codes; the
// <select> hands back a plain string, so narrow through the known options.
type LocaleCode = Parameters<typeof setLocale>[0]

async function switchLocale(code: string) {
  const match = availableLocales.value.find((l) => l.code === code)
  if (match) await setLocale(match.code as LocaleCode)
}
</script>

<template>
  <div class="relative inline-flex items-center gap-1">
    <label for="language-select" class="sr-only">{{ $t('common.language') }}</label>
    <select
      id="language-select"
      :value="locale"
      class="appearance-none rounded-md border border-[var(--color-border)] bg-[var(--color-background)] py-1.5 pr-8 pl-3 text-sm text-[var(--color-foreground)] shadow-sm transition-colors hover:border-[var(--color-primary)] focus:border-[var(--color-primary)] focus:ring-1 focus:ring-[var(--color-primary)] focus:outline-none"
      @change="switchLocale(($event.target as HTMLSelectElement).value)"
    >
      <option v-for="loc in availableLocales" :key="loc.code" :value="loc.code">
        {{ loc.name }}
      </option>
    </select>
    <span
      class="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-[var(--color-muted-foreground)]"
      aria-hidden="true"
    >
      ▾
    </span>
  </div>
</template>
