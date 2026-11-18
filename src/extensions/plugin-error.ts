export class PluginError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'PluginError';
  }
}
