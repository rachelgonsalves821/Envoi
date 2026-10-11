import type { Plugin } from 'vite';

// The production Container serves one self-contained HTML file. Keep this
// deliberately narrow: the web app has one entry point, and a split build
// should fail rather than silently ship a broken page.
export function inlineWebBuild(): Plugin {
  return {
    name: 'envoi:inline-web-build',
    enforce: 'post',
    config(config) {
      config.base = './';
      config.build ??= {};
      config.build.assetsInlineLimit = () => true;
      config.build.cssCodeSplit = false;
      config.build.assetsDir = '';
      config.build.chunkSizeWarningLimit = 100000000;
      config.build.rollupOptions ??= {};
      config.build.rollupOptions.output = { codeSplitting: false };
    },
    generateBundle(_options, bundle) {
      const html = bundle['index.html'];
      if (!html || html.type !== 'asset') throw new Error('Expected one index.html asset');
      const scripts = Object.values(bundle).filter(item => item.type === 'chunk' && item.fileName.endsWith('.js'));
      const styles = Object.values(bundle).filter(item => item.type === 'asset' && item.fileName.endsWith('.css'));
      if (scripts.length !== 1 || styles.length !== 1) throw new Error('Expected one JavaScript and one CSS bundle');

      let page = String(html.source);
      const script = scripts[0];
      if (script.type !== 'chunk') throw new Error('Expected a JavaScript chunk');
      const scriptTag = new RegExp(`<script([^>]*?)\\s+src="(?:[^"]*/)?${escapeRegExp(script.fileName)}"([^>]*)></script>`);
      if (!scriptTag.test(page)) throw new Error('Could not find the emitted JavaScript tag');
      const safeScript = script.code.replace(/__VITE_PRELOAD__/g, 'void 0').replace(/<(\/script>|!--)/g, '\\x3C$1');
      page = page.replace(scriptTag, (_match, before: string, after: string) => `<script${before}${after}>${safeScript.trim()}</script>`);

      const style = styles[0];
      if (style.type !== 'asset') throw new Error('Expected a CSS asset');
      const styleTag = new RegExp(`<link([^>]*?)\\s+href="(?:[^"]*/)?${escapeRegExp(style.fileName)}"([^>]*)>`);
      if (!styleTag.test(page)) throw new Error('Could not find the emitted CSS link');
      const safeStyle = String(style.source).replace('@charset "UTF-8";', '');
      page = page.replace(styleTag, (_match, before: string, after: string) => `<style${before}${after}>${safeStyle.trim()}</style>`);

      html.source = page;
      delete bundle[script.fileName];
      delete bundle[style.fileName];
    }
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
