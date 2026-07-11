import { ref, readonly } from 'vue'

export interface Toast {
  id: string
  type: 'success' | 'error' | 'warning' | 'info'
  message: string
  duration: number
}

export interface ToastOptions {
  type?: Toast['type']
  message: string
  duration?: number
}

const toasts = ref<Toast[]>([])

function addToast(options: ToastOptions): string {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const toast: Toast = {
    id,
    type: options.type ?? 'info',
    message: options.message,
    duration: options.duration ?? 4000,
  }
  toasts.value.push(toast)
  if (toast.duration > 0) {
    setTimeout(() => removeToast(id), toast.duration)
  }
  return id
}

function removeToast(id: string): void {
  const index = toasts.value.findIndex((t) => t.id === id)
  if (index !== -1) toasts.value.splice(index, 1)
}

export function useToast() {
  return {
    toasts: readonly(toasts),
    addToast,
    removeToast,
    success: (message: string, duration?: number) =>
      addToast({ type: 'success', message, duration }),
    error: (message: string, duration?: number) =>
      addToast({ type: 'error', message, duration }),
    warning: (message: string, duration?: number) =>
      addToast({ type: 'warning', message, duration }),
    info: (message: string, duration?: number) =>
      addToast({ type: 'info', message, duration }),
  }
}
