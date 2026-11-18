import {defineConfig} from '@playwright/test';
import {resolve,join} from 'node:path';
import {tmpdir} from 'node:os';
export default defineConfig({testDir:'.',testMatch:'nwc-browser.spec.ts',workers:1,timeout:35000,expect:{timeout:5000},outputDir:join(tmpdir(),'ql-nwc-browser-artifacts'),reporter:[['list']],use:{baseURL:'http://localhost:4364',browserName:'chromium',headless:true,launchOptions:{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE??'/usr/bin/chromium'}},webServer:{command:'node --max-old-space-size=512 --import tsx tests/nwc-browser-app.ts',cwd:resolve(import.meta.dirname,'..'),url:'http://localhost:4364',reuseExistingServer:false}});
