<script setup lang="ts">
import { todoGatewayInjection } from '../utils/todoGateway'

import type { TodoGateway } from '~/types/todos'

/**
 * The seam. Everything rendered in the default slot depends on `TodoGateway`;
 * this component decides which implementation that is.
 *
 * It provides `props.gateway` once, at setup, and deliberately does not watch
 * it: an injected value that changes identity underneath a subtree leaves that
 * subtree holding state loaded from the previous backend. A caller that wants
 * to switch adapters keys this component by the adapter, so Vue unmounts the
 * old subtree and mounts a fresh one — see `pages/dependency-inversion.vue`.
 */
const props = defineProps<{ gateway: TodoGateway }>()

todoGatewayInjection.provide(props.gateway)
</script>

<template>
  <slot />
</template>
