export type StandardFormat = 'chat' | 'messages' | 'responses';
export interface WireSettings {
  format: StandardFormat | 'custom';
  protocol?: StandardFormat;
  path?: string;
  authHeader?: string;
  requestFields?: Record<string, string>;
  responseFields?: Record<string, string>;
  streamFields?: Record<string, string>;
  toolFields?: Record<string, string>;
}

export interface DiscoveredModel {
  id: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  inputTypes?: ('text' | 'image' | 'pdf' | 'video')[];
}
