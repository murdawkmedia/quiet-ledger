import {defineConfig} from '@playwright/test';
import {resolve} from 'node:path';
export default defineConfig({
  testDir:'.',testMatch:'invoice-ledger-ui.spec.ts',workers:1,timeout:25000,expect:{timeout:5000},
  outputDir:'.runtime/invoice-ledger-ui-results',reporter:[['list']],
  use:{actionTimeout:6000,baseURL:'http://127.0.0.1:4347',browserName:'chromium',headless:true,launchOptions:{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE??'/usr/bin/chromium'}},
  webServer:{command:'node --import tsx tests/invoice-ledger-ui-app.ts',cwd:resolve(import.meta.dirname,'..'),url:'http://127.0.0.1:4347/tests/fixtures/invoice-ledger-ui.html',reuseExistingServer:false},
});
