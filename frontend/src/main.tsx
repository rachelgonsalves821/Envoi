import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource-variable/commissioner';
import '@fontsource/instrument-serif/latin-400.css';
import '@fontsource-variable/instrument-sans/wght.css';
import '@fontsource-variable/newsreader/wght.css';
import '@fontsource/geist-mono/latin-400.css';
import App from './App';
import './styles/tokens.css';
import './styles/app.css';
import './styles/landing.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><App /></React.StrictMode>
);
