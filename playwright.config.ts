import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser',
  testIgnore: ['adversarial.spec.ts','hosted-accounts.spec.ts','passkey-manager.spec.ts','saved-connections.spec.ts','marmot-demo.spec.ts','marmot-invoice.spec.ts','demo-team.spec.ts','invoice-email.spec.ts','client-threads.spec.ts','email-inbox.spec.ts','production-messages.spec.ts'],
  timeout: 45_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:4318',
    browserName: 'chromium',
    headless: true,
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ?? '/usr/bin/chromium' },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:4318/api/health',
    timeout: 60_000,
    reuseExistingServer: false,
    env: { PORT: '4318', DATA_DIR: '.runtime/browser-tests', OWNER_TOKEN: 'e2e-only-owner-fixture', PRIVATE_SCENARIO_PATH: 'tests/fixtures/owner-scenario.json', SIMULATION_ONLY: 'true' },
  },
});
