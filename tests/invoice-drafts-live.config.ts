import {defineConfig} from '@playwright/test';
import {resolve} from 'node:path';
import merchant from './merchant-billing-browser.config';

export default defineConfig({...merchant,testMatch:'invoice-drafts-live.spec.ts',
  outputDir:resolve(process.env.QUIET_LEDGER_INVOICE_DRAFTS_ARTIFACTS??'.runtime/invoice-drafts-live','results')});
