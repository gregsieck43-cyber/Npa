import type { ProviderConfig, ToolDefinition } from '../contracts.js';

/** Conservative preflight bound, not a tokenizer estimate or a reported usage value.
 * UTF-16 characters cost at most three UTF-8 bytes; byte fallback also bounds text tokens.
 * The provider's exact returned usage remains the source for UI usage statistics. */
export function workingContextBudget(config: Partial<ProviderConfig>, tools: ToolDefinition[] = []): number {
  const schemas = Buffer.byteLength(JSON.stringify(tools));
  const request = (config.maxRequestBytes ?? 131072) - schemas - 2048;
  const window = config.contextWindowTokens === undefined ? Infinity
    : config.contextWindowTokens - (config.maxOutputTokens ?? 4096) - schemas - 2048;
  const chars = Math.min(32000, Math.floor(Math.min(request, window) / 3));
  if (chars < 2048) throw new RangeError('The configured input/context limit cannot fit enabled tools, output reserve and a working window. Increase the limit or select fewer tools.');
  return chars;
}
