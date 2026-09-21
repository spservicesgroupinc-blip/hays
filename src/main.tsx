import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { registerSW } from 'virtual:pwa-register';

// Register PWA service worker with immediate check
registerSW({
  immediate: true,
  onNeedRefresh() {
    console.log('PWA applet updated, refreshing service worker cache.');
  },
  onOfflineReady() {
    console.log('PWA is offline-ready.');
  }
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
