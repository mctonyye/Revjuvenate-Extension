import { defineManifest } from '@crxjs/vite-plugin'

export default defineManifest({
  manifest_version: 3,
  name: 'Revjuvenate Browser Automation',
  version: '0.2.0',
  description:
    'Run Revjuvenate automation recipes directly in your browser with your own login and access levels.',
  icons: {
    16: 'icons/icon16.png',
    32: 'icons/icon32.png',
    48: 'icons/icon48.png',
    128: 'icons/icon128.png',
  },
  action: {
    default_title: 'Open Revjuvenate panel',
  },
  side_panel: {
    default_path: 'src/sidepanel/index.html',
  },
  background: {
    service_worker: 'src/background/index.ts',
    type: 'module',
  },
  content_scripts: [
    {
      matches: ['<all_urls>'],
      js: ['src/content/index.ts'],
      run_at: 'document_idle',
      all_frames: true,
    },
    {
      matches: ['<all_urls>'],
      js: ['src/content/dialog.js'],
      run_at: 'document_start',
      all_frames: true,
      world: 'MAIN',
    },
  ],
  permissions: ['sidePanel', 'storage', 'activeTab', 'tabs', 'scripting'],
  host_permissions: ['<all_urls>'],
})
