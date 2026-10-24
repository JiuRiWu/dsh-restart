/**
 * dsh-restart 的宿主半边。
 *
 * 这里刻意留空：重启这件事从头到尾都由外壳（Electron 主进程）负责——按钮只调用新增的
 * `window.dshDesktop.restartApplication()`，随后是外壳自己的原生确认框、优雅关闭与重新拉起。
 * 宿主侧不需要注册 service、command 或 tool，所以一个可加载的空 bundle 就够了。
 */
export function apply() {}