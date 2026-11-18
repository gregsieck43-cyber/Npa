export function brandProduct(upstream: Record<string, any>, version: string): Record<string, any> {
  return { ...upstream, nameShort: 'NPN IDE', nameLong: 'NPN Gamma IDE', applicationName: 'npn-ide',
    dataFolderName: '.npn-gamma-ide', sharedDataFolderName: '.npn-gamma-shared',
    win32MutexName: 'npn-gamma-ide', win32DirName: 'NPN Gamma IDE', win32NameVersion: 'NPN Gamma IDE',
    win32RegValueName: 'NPN Gamma IDE', win32AppUserModelId: 'NPN.Gamma.IDE', win32ShellNameShort: 'NPN Gamma IDE',
    reportIssueUrl: '', updateUrl: '', npnVersion: version,
    npnUpstream: { name: 'VSCodium / Code - OSS', version: upstream.version ?? '1.135.06055', license: 'MIT; upstream notices retained' } };
}

export function npnWatermark(dark: boolean): string {
  const color = dark ? '#373b42' : '#e3ded2';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256"><text x="128" y="148" text-anchor="middle" font-family="Segoe UI,sans-serif" font-size="68" font-weight="600" letter-spacing="-4" fill="${color}">NPN</text><path d="M58 176h140" stroke="${color}" stroke-width="2"/></svg>`;
}
