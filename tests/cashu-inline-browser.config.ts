import {defineConfig} from '@playwright/test';
import {resolve} from 'node:path';
import {tmpdir} from 'node:os';
export default defineConfig({testDir:'.',testMatch:'cashu-inline-browser.spec.ts',workers:1,timeout:35000,expect:{timeout:6000},outputDir:resolve(tmpdir(),'ql-cashu-built-browser'),reporter:[['list']],use:{baseURL:'http://localhost:4367',browserName:'chromium',headless:true,acceptDownloads:true,launchOptions:{executablePath:'/usr/bin/chromium'}},webServer:{command:'node --max-old-space-size=512 --import tsx tests/cashu-inline-browser-app.ts',cwd:resolve(import.meta.dirname,'..'),url:'http://localhost:4367',reuseExistingServer:false}});
