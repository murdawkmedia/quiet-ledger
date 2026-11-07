import {defineConfig} from '@playwright/test';
export default defineConfig({testDir:'./browser',testMatch:['method-pricing-live.spec.ts','sat-invoice-live.spec.ts'],workers:1,timeout:45000,expect:{timeout:8000},reporter:[['list']],outputDir:'.runtime/financial-live-results',use:{browserName:'chromium',headless:true,launchOptions:{executablePath:'/usr/bin/chromium'}}});
