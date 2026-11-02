const imageNames = new Set(['envoi-brand.png', 'envoi-logo.png', 'monad-logo-mark.png', 'og-image.png']);

export function marketingRoute(pathname) {
  if (pathname === '/') return { file: 'index.html' };
  if (pathname === '/product') return { redirect: '/product/' };
  if (pathname === '/product/') return { file: 'product/index.html' };
  if (pathname === '/create-account') return { redirect: '/create-account/' };
  if (pathname === '/create-account/') return { file: 'create-account/index.html' };
  if (pathname === '/team' || pathname === '/team/') return { redirect: '/#team' };
  if (pathname === '/share') return { redirect: '/share/' };
  if (pathname === '/share/') return { file: 'share/index.html' };
  if (pathname.startsWith('/_astro/') || pathname.startsWith('/agents/') || pathname.startsWith('/team/')) return { file: pathname.slice(1) };
  if (imageNames.has(pathname.slice(1))) return { file: pathname.slice(1) };
  return null;
}

export function nonceStaticHtml(html, nonce) {
  return html
    .replace(/<script\b(?![^>]*\bnonce=)/g, `<script nonce="${nonce}"`)
    .replace(/<style\b(?![^>]*\bnonce=)/g, `<style nonce="${nonce}"`)
    .replace(/<link\b(?=[^>]*\brel="stylesheet")(?![^>]*\bnonce=)/g, `<link nonce="${nonce}"`);
}
