import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource-variable/commissioner';
import App from './App';
import './styles/tokens.css';
import './styles/app.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><App /></React.StrictMode>
);
