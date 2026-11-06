import {defineConfig} from '@playwright/test';
import config from './line-adjustments-ui.config';
export default defineConfig(config,{testMatch:['invoice-editor-ui.spec.ts','payment-terms-ui.spec.ts'],outputDir:'.runtime/line-adjustments-ui-regression-results'});
