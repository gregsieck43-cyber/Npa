import { BridgeGateway, type NpnBridge } from './bridge';
import type { NpnGateway } from './contract';
import { MockGateway } from './mock/gateway';

declare const __NPN_GATEWAY__: 'mock' | 'bridge';
declare global { interface Window { npn?: NpnBridge } }

/** 构建时由 scripts/build-frontend.mjs 注入；bridge 构建要求 Electron preload 提供 window.npn。 */
function createGateway(): NpnGateway {
  if (__NPN_GATEWAY__ === 'bridge') {
    if (!window.npn) throw new Error('bridge 构建必须运行在提供 window.npn 的 Electron 渲染进程中');
    return new BridgeGateway(window.npn);
  }
  return new MockGateway();
}

export const gateway = createGateway();
export * from './contract';
export type * from './types';
