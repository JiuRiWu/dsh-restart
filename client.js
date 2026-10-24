/**
 * dsh-restart 的浏览器半边：在侧边栏底部（`sidebar.footer.action`）放一个「重启」按钮。
 *
 * 按钮自己不做任何关闭动作，只调用外壳新增的 `window.dshDesktop.restartApplication()`：
 * 原生确认框、优雅关闭、重新拉起全部在外壳里完成，走的是托盘「退出 DeepSeek Harness」
 * 那条完全相同的路径。因此这里没有自绘对话框，也没有任何强杀逻辑。
 *
 * 文案走 DSH 自己的客户端语言服务（`ctx.locale`），与「新会话」「打开侧边栏」等
 * 官方文案同源，语言跟随界面设置。不能用 `document.documentElement.lang` 判断：
 * 前端 `dist/index.html` 里写死了 `<html lang="en">`，那个信号永远是 en。
 *
 * 样式照抄官方侧边栏底部按钮（`@deepseek-ai/dsh-client-ui-cordis` 的 `.badge`）：
 * 宽态 42px 行高 + 图标 + 文字，收起态（rail）36px 圆按钮，只用 `--dsw-alias-*` 令牌。
 */
window.__ModuleLoader__.load({
  id: 'dsh-restart',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const PLUGIN = 'dsh-restart';
    /** 词典命名空间，同时也是槽注册里 `locale` 的取值。 */
    const NS = 'dsh-restart';
    const CSS_TAG = `${PLUGIN}/RestartButton.module.css`;

    /** 简体中文字典（键集以它为准）。 */
    const zh = {
      restart: '重启',
      'restart.aria': '重启 DeepSeek Harness',
      'restart.missing': '重启入口不可用：配套的外壳补丁未安装',
    };

    /** 英文字典。 */
    const en = {
      restart: 'Restart',
      'restart.aria': 'Restart DeepSeek Harness',
      'restart.missing': 'Restart unavailable: the matching shell patch is not installed',
    };

    // 与官方模块同款写法：带 data-plugin-css 标记的 <style>，重复加载时幂等。
    const css = [
      '.dsr-badge{width:calc(100% + 4px);height:42px;color:var(--dsw-alias-label-primary);',
      'cursor:pointer;background:0 0;border:none;border-radius:12px;align-items:center;gap:8px;',
      'margin:0 -2px;padding:0 10px 0 8px;font-family:inherit;font-size:14px;display:inline-flex;overflow:hidden}',
      '.dsr-badge:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsr-badge:disabled{cursor:default;opacity:.55}',
      '.dsr-badge:focus-visible{outline:2px solid var(--dsw-alias-label-primary);outline-offset:-2px}',
      '.dsr-badge[data-rail]{width:36px;height:36px;padding:0;gap:0;margin:0;border-radius:50%;',
      'justify-content:center;corner-shape:round}',
      '.dsr-label{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}',
    ].join('');
    if (
      typeof document !== 'undefined' &&
      document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_TAG) + ']') === null
    ) {
      const tag = document.createElement('style');
      tag.dataset.plugin = PLUGIN;
      tag.dataset.pluginCss = CSS_TAG;
      tag.textContent = css;
      document.head.appendChild(tag);
    }

    /** 外壳补丁暴露的入口；没打补丁时返回 null。 */
    function restartBridge() {
      const desktop = typeof window === 'undefined' ? void 0 : window.dshDesktop;
      const call = desktop === void 0 ? void 0 : desktop.restartApplication;
      return typeof call === 'function' ? call : null;
    }

    const IconRestart = (props) =>
      h(
        'svg',
        {
          width: props.size,
          height: props.size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        [
          h('path', { key: 'arc', d: 'M20.5 12a8.5 8.5 0 1 1-8.3-8.5' }),
          h('path', { key: 'tip', d: 'M9.3 1.1 12.5 3.5 9.3 5.9' }),
        ],
      );

    function RestartButton(props) {
      const wide = props.wide === true;
      // 槽注册里声明了 locale，框架会注入 t；万一没注入就退回英文词典，不显示裸键名。
      const t = typeof props.t === 'function' ? props.t : (key) => (en[key] !== void 0 ? en[key] : key);
      const call = restartBridge();
      const title = call === null ? t('restart.missing') : t('restart.aria');
      return h(
        'button',
        {
          type: 'button',
          className: 'dsr-badge',
          'data-rail': wide ? void 0 : '',
          disabled: call === null,
          title,
          'aria-label': title,
          onClick: () => {
            if (call === null) return;
            // 批准后外壳会立刻优雅退出并重新拉起，这个 promise 通常不会再落地。
            Promise.resolve(call()).catch((error) => {
              console.error('[dsh-restart] restart request failed', error);
            });
          },
        },
        [
          h(IconRestart, { key: 'icon', size: wide ? 16 : 18 }),
          wide ? h('span', { key: 'label', className: 'dsr-label' }, t('restart')) : null,
        ],
      );
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-restart: dictionaries');
        if (restartBridge() === null) {
          console.warn(
            '[dsh-restart] window.dshDesktop.restartApplication is missing — ' +
              'the DSH Desktop shell patch is not installed, so the button stays disabled.',
          );
        }
        ctx.slots.inject('sidebar.footer.action', () =>
          ctx.slots.register(
            {
              name: 'sidebar.footer.action',
              id: PLUGIN,
              order: 20,
              locale: NS,
            },
            RestartButton,
          ),
        );
      },
    };
  },
});