import {defineConfig} from '@playwright/test';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
export default defineConfig({testDir:'.',testMatch:'demo-live-browser.spec.ts',workers:1,timeout:30000,expect:{timeout:5000},
  outputDir:join(tmpdir(),'ql-demo-live-actual-browser'),reporter:[['list']],
  use:{baseURL:'http://localhost:4359',browserName:'chromium',headless:true,launchOptions:{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE??'/usr/bin/chromium'}},
  webServer:{command:'node --max-old-space-size=512 --import tsx tests/demo-live-browser-app.ts',cwd:resolve(import.meta.dirname,'..'),url:'http://localhost:4359',reuseExistingServer:false},
});
