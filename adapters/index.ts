/** Registry and factory for the supported text-generation providers. */
export * from './types';
export { GroqAdapter, getGroqAdapter } from './groq-adapter';
export { GoogleAdapter, getGoogleAdapter } from './google-adapter';
export { OpenRouterAdapter, getOpenRouterAdapter } from './openrouter-adapter';
export { CloudflareAdapter, getCloudflareAdapter } from './cloudflare-adapter';

import type { ProviderAdapter } from './types';
import type { ProviderType } from '../routing/model-config';
import { getGroqAdapter } from './groq-adapter';
import { getGoogleAdapter } from './google-adapter';
import { getOpenRouterAdapter } from './openrouter-adapter';
import { getCloudflareAdapter } from './cloudflare-adapter';

export function getAdapter(providerType: ProviderType): ProviderAdapter {
  switch (providerType) {
    case 'groq': return getGroqAdapter();
    case 'google': return getGoogleAdapter();
    case 'openrouter': return getOpenRouterAdapter();
    case 'cloudflare': return getCloudflareAdapter();
    default: throw new Error(`Unsupported chat provider: ${providerType}`);
  }
}

export function hasAnyProviderAvailable(): boolean {
  return [getGroqAdapter(), getGoogleAdapter(), getOpenRouterAdapter(), getCloudflareAdapter()]
    .some(adapter => adapter.isAvailable());
}
