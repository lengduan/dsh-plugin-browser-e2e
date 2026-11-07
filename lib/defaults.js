/**
 * 插件全局默认值：host 实现与 client 构建注入共用同一份值，避免「默认端点」这类常量
 * 在 session.js / Config / client 里各写一遍后漂移。
 */

/** 默认 CDP 端点：session.launch 的缺省端点、插件 Config 的默认值、client 插件配置缺省值同源。 */
export const DEFAULT_CDP_ENDPOINT = 'http://127.0.0.1:9222'
