/** Native messaging and browser CSP use the same explicitly reviewed origins. */
export const PUBLIC_MARMOT_RELAY_ORIGINS=['wss://relay.us.whitenoise.chat','wss://relay.eu.whitenoise.chat'] as const;
export const MARMOT_RELAY_CSP=PUBLIC_MARMOT_RELAY_ORIGINS.join(' ');
