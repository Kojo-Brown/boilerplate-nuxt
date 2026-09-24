import type { User } from '#auth-utils'

import { signInSession } from '~/server/utils/session-rotation'
import { registerCurrentSession } from '~/server/utils/session-store'

export default defineOAuthGitHubEventHandler({
  config: {
    scope: ['user:email'],
  },
  async onSuccess(event, { user: githubUser }) {
    const user: User = {
      id: String(githubUser.id),
      login: githubUser.login as string,
      name: (githubUser.name ?? githubUser.login) as string,
      email: (githubUser.email ?? '') as string,
      avatarUrl: githubUser.avatar_url as string,
      provider: 'github',
    }

    // Minted and stamped for the reasons the credentials path spells out in
    // `server/api/auth/login.post.ts`.
    await setUserSession(event, signInSession(user))

    // Same as the credentials path in `api/auth/login.post.ts`: the session id
    // exists only once the session has been minted, and registering it is what
    // makes this session revocable. See server/utils/session-store.ts.
    await registerCurrentSession(event, user)

    return sendRedirect(event, '/')
  },
  onError(event, error) {
    console.error('GitHub OAuth error:', error)
    return sendRedirect(event, '/login?error=github_oauth_failed')
  },
})
