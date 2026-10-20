import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource-variable/inter';
import '@fontsource-variable/commissioner';
import '@fontsource/instrument-serif/latin-400.css';
import '@fontsource-variable/instrument-sans/wght.css';
import '@fontsource-variable/newsreader/wght.css';
import '@fontsource/geist-mono/latin-400.css';
import App from './App';
import MarketingPage from './MarketingPage';
import { initAnalytics } from './analytics';
import './styles/tokens.css';
import './styles/app.css';
import './styles/envoi-app.css';

initAnalytics();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>{['/about', '/about/', '/product', '/product/'].includes(window.location.pathname)
    ? <MarketingPage page={window.location.pathname.startsWith('/product') ? 'product' : 'about'} signInPath="/api/auth/workos/sign-in" />
    : <App />}</React.StrictMode>
);
