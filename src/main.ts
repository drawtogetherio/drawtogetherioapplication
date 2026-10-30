import './style.css';
import { DrawDoc } from './core/document';
import { App } from './ui/app';
import { initTheme } from './ui/theme';
import { initTooltips } from './ui/tooltip';

initTheme();
initTooltips();
const root = document.getElementById('app')!;
const app = new App(root, DrawDoc.create({ width: 2048, height: 2048, infinite: true, background: '#ffffff' }));
app.session.start();
if (import.meta.env.PROD && 'serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

(window as unknown as { doodlehive: App }).doodlehive = app;

