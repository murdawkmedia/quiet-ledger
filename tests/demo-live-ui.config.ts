import {defineConfig} from '@playwright/test';
import {resolve,join} from 'node:path';
import {tmpdir} from 'node:os';
export default defineConfig({
  testDir:'.',testMatch:'demo-live-ui.spec.ts',workers:1,timeout:20000,expect:{timeout:4000},
  outputDir:join(tmpdir(),'demo-live-browser-results'),reporter:[['list']],
  use:{actionTimeout:5000,baseURL:'http://127.0.0.1:4358',browserName:'chromium',headless:true,launchOptions:{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE??'/usr/bin/chromium'}},
  webServer:{command:'node --max-old-space-size=512 --import tsx tests/demo-live-ui-app.ts',cwd:resolve(import.meta.dirname,'..'),url:'http://127.0.0.1:4358/tests/fixtures/demo-live-ui.html',reuseExistingServer:false},
});
