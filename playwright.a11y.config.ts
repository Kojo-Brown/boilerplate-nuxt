import { fileURLToPath } from 'node:url'

import { defineConfig, devices } from '@playwright/test'

import { COLOUR_SCHEMES } from './a11y.config'

/**
 * The WCAG 2.2 AA gate, run against a production build.
 *
 * A separate config rather than a project inside `playwright.config.ts` because
 * the two suites need different servers, and Playwright's `webServer` is a
 * property of the config, not of a project. The difference is the whole point:
 *
 *  - **`pnpm dev` injects Nuxt DevTools.** Its toolbar is part of the document
 *    axe sees, and it has contrast failures of its own. Auditing the dev server
 *    means either reporting violations in a toolbar that never ships, or adding
 *    an `exclude` selector — and an exclude list is a place where a real
 *    violation can hide for a year.
 *  - **The dev CSP is weaker** and the dev stylesheet is unminified and injected
 *    from JavaScript. Contrast is measured on computed style, so the thing that
 *    gets audited should be the stylesheet that gets deployed.
 *  - **Prerendered routes only exist in a build.** `/route-rules/static` is
 *    emitted as static HTML at build time and is served by the dev renderer
 *    instead, so the bytes a visitor receives are only auditable here.
 *
 * It therefore expects `pnpm build` to have run: `pnpm test:a11y` chains the two.
 *
 * Every page is audited once per colour scheme (see `a11y.config.ts`), expressed
 * as one Playwright project each so a failure names the palette it was in.
 */

const BASE_URL = process.env['NUXT_APP_BASE_URL'] ?? 'http://localhost:3000'

/**
 * Where `tests/e2e/a11y.setup.ts` leaves the signed-in session.
 *
 * Under `.playwright/` rather than `test-results/`, which Playwright empties at
 * the start of every run — including between the setup project and the projects
 * that depend on it when a run is resumed with `--last-failed`.
 */
export const A11Y_AUTH_STATE = fileURLToPath(new URL('.playwright/a11y-auth.json', import.meta.url))

const SETUP_PROJECT = 'a11y-setup'

export default defineConfig({
  testDir: './tests/e2e',
  // Just this file and its setup. The rest of `tests/e2e/` exercises the dev
  // server through `playwright.config.ts`.
  testMatch: /a11y\.(test|setup)\.ts$/,
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  // No retries, on CI or off. A retry is for a flaky assertion, and an axe
  // violation is not flaky — it is either in the markup or it is not. Letting a
  // retry pass the gate would mean the gate reports whichever of two runs was
  // kinder. Anything that genuinely does flake here (a page that had not
  // settled) is a bug in this suite's waiting, and silence is how it survives.
  retries: 0,
  ...(process.env['CI'] ? { workers: 2 } : {}),
  // `github` annotates the failing line in the PR diff; `list` is what makes
  // the job log readable, since a violation's useful detail is the message body
  // rather than its position in a file.
  reporter: process.env['CI'] ? [['github'], ['list']] : [['list']],
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: SETUP_PROJECT, testMatch: /a11y\.setup\.ts$/ },
    ...COLOUR_SCHEMES.map((colorScheme) => ({
      name: `a11y-${colorScheme}`,
      testMatch: /a11y\.test\.ts$/,
      dependencies: [SETUP_PROJECT],
      use: {
        ...devices['Desktop Chrome'],
        colorScheme,
        storageState: A11Y_AUTH_STATE,
      },
    })),
  ],
  webServer: {
    // The built server, not `nuxt preview`: `preview` is a wrapper that re-reads
    // the Nuxt config to find the output directory, and on a machine where the
    // build has not run it starts a server for a stale `.output/`. Running the
    // entry point directly fails loudly instead.
    command: 'node .output/server/index.mjs',
    url: BASE_URL,
    reuseExistingServer: !process.env['CI'],
    timeout: 120_000,
    env: {
      // The built server refuses to boot without a session password — that is what
      // `server/plugins/session-hardening.ts` is for. A throwaway for a throwaway
      // server: it signs cookies for one audit run and is never a deployment's
      // key.
      NUXT_SESSION_PASSWORD:
        process.env['NUXT_SESSION_PASSWORD'] ?? 'a11y-audit-only-session-password-not-a-secret',

      // No page in the audit reads the database — the one that can
      // (`/dependency-inversion`) defaults to its in-memory gateway — so the audit
      // needs no Postgres, and CI does not start one. The outbox relay polls
      // regardless, so without this the server fills the job log with connection
      // failures and a real failure becomes hard to find. Saying it is deliberate
      // is also what the warning in `server/utils/outbox.ts` asks for.
      NUXT_OUTBOX_RELAY_ENABLED: 'false',
    },
  },
})
