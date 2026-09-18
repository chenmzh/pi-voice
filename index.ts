import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
// Keep local runtime modules in TypeScript: Pi /reload cannot evict native ESM .mjs caches.
import registerVoice from './extension.ts';

export default function (pi: ExtensionAPI) {
  registerVoice(pi);
}
