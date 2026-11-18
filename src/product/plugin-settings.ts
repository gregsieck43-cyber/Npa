/**
 * Plugin list adapter for Settings. The registry keeps the digests and the operator switch; this
 * module only maps that real state to the frontend PluginView and never installs or executes a plugin.
 */
import type { Capability, PluginView } from '../frontend/api/types.js';
import type { PluginManager } from '../extensions/plugins.js';

/**
 * A plugin permission maps to the frontend capability the executor needs to exercise it. The native
 * plugin API can only request text.transform, which the local text executor performs; plugins cannot
 * request files, commands, network, approval or kernel access at all.
 */
const PLUGIN_CAPABILITIES: Record<string, Capability> = { 'text.transform': 'exec' };

function capabilities(permissions: readonly string[]): Capability[] {
  const mapped = permissions.map(permission => PLUGIN_CAPABILITIES[permission]).filter((item): item is Capability => item !== undefined);
  return [...new Set(mapped)];
}

/**
 * enabled is the operator switch, approvalValid is digest-bound approval of the exact installed
 * artifact: an enabled plugin whose artifact is no longer approved is waiting for approval rather
 * than active, and a disabled plugin is disabled regardless of any earlier approval.
 */
export function pluginViews(items: ReturnType<PluginManager['list']>): PluginView[] {
  return items.map(item => ({
    id: item.id,
    name: item.name,
    version: item.version,
    status: !item.enabled ? 'disabled' : item.approvalValid ? 'active' : 'pending_approval',
    capabilities: capabilities(item.manifest.permissions),
    description: item.manifest.description ?? '',
  }));
}
