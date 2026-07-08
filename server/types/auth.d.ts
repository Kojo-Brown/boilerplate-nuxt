declare module '#auth-utils' {
  interface User {
    id: string
    email: string
    name: string
    provider: 'credentials' | 'github'
    login?: string
    avatarUrl?: string
  }

  interface UserSession {
    user: User
  }
}

export {}
