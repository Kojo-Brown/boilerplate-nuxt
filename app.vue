<template>
  <NuxtRouteAnnouncer />
  <AppToastContainer />
  <NuxtPage />
</template>

<style>
@import 'tailwindcss';

:root {
  --color-background: #ffffff;
  --color-foreground: #0a0a0a;
  --color-primary: #4f46e5;
  --color-primary-foreground: #ffffff;
  --color-muted: #f4f4f5;
  --color-muted-foreground: #71717a;
  --color-border: #e4e4e7;
}

.dark {
  --color-background: #09090b;
  --color-foreground: #fafafa;
  --color-primary: #6366f1;
  --color-primary-foreground: #ffffff;
  --color-muted: #27272a;
  --color-muted-foreground: #a1a1aa;
  --color-border: #27272a;
}

body {
  background-color: var(--color-background);
  color: var(--color-foreground);
}
</style>
