export default defineOAuthGitHubEventHandler({
  config: {
    scope: ['user:email'],
  },
  async onSuccess(event, { user }) {
    await setUserSession(event, {
      user: {
        id: String(user.id),
        login: user.login as string,
        name: (user.name ?? user.login) as string,
        email: (user.email ?? '') as string,
        avatarUrl: user.avatar_url as string,
        provider: 'github',
      },
    })
    return sendRedirect(event, '/')
  },
  onError(event, error) {
    console.error('GitHub OAuth error:', error)
    return sendRedirect(event, '/login?error=github_oauth_failed')
  },
})
