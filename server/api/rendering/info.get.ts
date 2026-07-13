export default defineEventHandler(() => ({
  timestamp: new Date().toISOString(),
  random: Math.random(),
  mode: 'SSR',
}))
