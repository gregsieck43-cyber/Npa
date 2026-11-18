import { PROVIDER_IMPORT_MAX_BYTES, parseProviderImport, providerImportSummary, providerProfileBody, type ProviderImportSettings } from './provider-connection.js';

/** Non-secret display facts for the native confirmation dialog. */
export interface ProviderImportConfirmation {
    message: string;
    detail: string;
}

/**
 * Build the confirmation the native dialog shows. Only the settings the user explicitly chose are
 * displayed; the credential file path is shown, its contents never are. This module never reads
 * the credential file: saving the profile through the existing Configuration authority reads it
 * from that explicit path, uses it in memory and persists only the path.
 */
export function formatProviderImportConfirmation(settings: ProviderImportSettings): ProviderImportConfirmation {
    const summary = providerImportSummary(settings);
    const detail = [
        '提供方：' + summary.providerLabel,
        '配置名称：' + summary.name,
        '地址：' + summary.endpoint,
        '模型：' + summary.model,
        '请求额度：' + summary.requestLimit + ' 次 / 授权 ' + summary.authorizeDays + ' 天',
        '凭据文件：' + summary.credentialFile,
        ...(summary.contextWindowTokens === undefined ? [] : ['上下文窗口：' + summary.contextWindowTokens + ' tokens']),
        ...(summary.supportsDeveloper ? ['支持 developer 角色'] : []),
        '',
        '只会保存上述非密钥设置；密钥内容不会显示、写入配置文件或记录到日志。',
        '保存时后台会从该凭据文件读取密钥到内存中使用；配置只保存这个路径，不复制文件。',
        '导入不会发起任何模型请求。取消不会修改任何设置。',
    ].join('\n');
    return { message: '确认导入模型连接', detail };
}

/**
 * Completion text after a successful import. The model list is live data: reopening
 * 设置 → 模型 reads it again, so the new profile appears without restarting the application.
 * Saving happened through Configuration.set, which reads the explicit credential file into
 * memory at that moment; only its path is persisted and the value is never displayed or logged.
 */
export function formatProviderImportCompletion(profileId?: string): ProviderImportConfirmation {
    const suffix = profileId === undefined ? '' : '（' + profileId + '）';
    return {
        message: '模型连接已导入，可在 设置 → 模型 中使用',
        detail: [
            '配置' + suffix + '已保存到现有模型配置。',
            '打开 设置 → 模型 会重新读取真实模型列表，无需重启整个应用。',
            '保存时后台已从你明确选择的凭据文件读取密钥到内存中使用；配置只保存该路径，不复制文件、不显示密钥内容、不记录到日志。',
            '导入不会发起任何模型请求。',
        ].join('\n'),
    };
}

export interface ProviderImportOptions {
    /** UTF-8 content of the JSON file the user picked; bounded by the parser. */
    text: string;
    /** True imports; false leaves every setting untouched. */
    confirm: (settings: ProviderImportSettings) => Promise<boolean>;
    /** Show the validated settings to the existing Profiles/Configuration authority. */
    save: (body: Record<string, unknown>) => Promise<unknown>;
}

export interface ProviderImportOutcome {
    status: 'imported' | 'cancelled';
    profile?: unknown;
}

/**
 * One import attempt. Parsing happens before the dialog, so invalid files never reach a
 * confirmation; a cancelled dialog never reaches the backend. The save body is exactly the
 * provider-profile input built by provider-connection, never a credential value.
 */
export async function performProviderImport(options: ProviderImportOptions): Promise<ProviderImportOutcome> {
    const settings = parseProviderImport(options.text);
    if (!(await options.confirm(settings))) return { status: 'cancelled' };
    const profile = await options.save(providerProfileBody(settings));
    return { status: 'imported', profile };
}

export { PROVIDER_IMPORT_MAX_BYTES };
