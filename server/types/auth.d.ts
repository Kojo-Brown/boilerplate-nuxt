declare module '#auth-utils' {
  interface User {
    id: string
    email: string
    name: string
    provider: 'credentials' | 'github'
    login?: string
    avatarUrl?: string
  }

  /**
   * What the sealed cookie carries.
   *
   * All three fields are declared as required rather than optional, and that is
   * the point of them: `setUserSession` takes `UserSession` minus its `id`, so a
   * sign-in path that forgets to stamp a session does not compile. Session
   * rotation and the absolute lifetime cap read all three — see
   * `server/utils/session-rotation.ts`.
   *
   * Required here is a claim about sessions this code mints. A cookie sealed
   * before these existed carries none of them, which is why they are read back
   * through `readSessionMarks()` and `readCredentialId()`, which treat an absent
   * value as "rotate and re-stamp" rather than trusting the type.
   */
  interface UserSession {
    user: User
    /**
     * The session identifier the registry is keyed on, and the thing rotation
     * rotates. h3's own `session.id` cannot serve: it is recovered by unsealing
     * whatever cookie the request carries, so no API changes it.
     */
    sid: string
    /**
     * `Date.now()` at the sign-in this session descends from. Carried across
     * every rotation, so it is what the absolute cap measures.
     */
    issuedAt: number
    /** `Date.now()` when the current `sid` was minted. Reset by rotation. */
    rotatedAt: number
  }
}

export {}
