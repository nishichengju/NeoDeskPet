const path = require('node:path')

const bundleBrowser = process.env.NDP_BUNDLE_BROWSER === '1'

module.exports = {
  appId: 'io.github.nishichengju.neodeskpet',
  productName: 'NeoDeskPet',
  copyright: 'Copyright © 2026 nishichengju',
  asar: true,
  asarUnpack: [
    'node_modules/better-sqlite3/**/*',
    'node_modules/bindings/**/*',
    'node_modules/file-uri-to-path/**/*',
    'node_modules/playwright-core/**/*',
  ],
  npmRebuild: true,
  directories: {
    output: bundleBrowser ? 'release/${version}/full' : 'release/${version}',
    buildResources: 'build',
  },
  files: [
    {
      from: 'dist',
      to: 'dist',
      filter: ['**/*', '!live2d/**/*', '!models/**/*'],
    },
    {
      from: 'dist/live2d',
      to: 'dist/live2d',
      filter: [
        'Haru/**/*',
        'Hiyori/**/*',
        'Mao/**/*',
        'Mark/**/*',
        'Natori/**/*',
        'Rice/**/*',
        'Wanko/**/*',
      ],
    },
    'dist-electron/**/*',
    'build/icon.png',
    'package.json',
    '!node_modules/**/*',
    '!dist/**/*.map',
    {
      from: 'node_modules/better-sqlite3',
      to: 'node_modules/better-sqlite3',
      filter: ['**/*'],
    },
    {
      from: 'node_modules/bindings',
      to: 'node_modules/bindings',
      filter: ['**/*'],
    },
    {
      from: 'node_modules/file-uri-to-path',
      to: 'node_modules/file-uri-to-path',
      filter: ['**/*'],
    },
    {
      from: 'node_modules/playwright-core',
      to: 'node_modules/playwright-core',
      filter: ['**/*'],
    },
  ],
  extraResources: bundleBrowser
    ? [
        {
          from: 'playwright-browsers',
          to: 'playwright-browsers',
          filter: ['**/*'],
        },
      ]
    : [],
  afterPack: path.join(__dirname, 'scripts', 'after-pack-brand.cjs'),
  mac: {
    icon: 'build/icon.png',
    category: 'public.app-category.utilities',
    target: ['dmg'],
    artifactName: bundleBrowser
      ? '${productName}-${version}-macOS-${arch}-Full.${ext}'
      : '${productName}-${version}-macOS-${arch}.${ext}',
  },
  win: {
    icon: 'build/icon.ico',
    executableName: 'NeoDeskPet',
    signAndEditExecutable: false,
    target: [
      {
        target: 'nsis',
        arch: ['x64'],
      },
    ],
    artifactName: bundleBrowser
      ? '${productName}-${version}-Windows-${arch}-Full-Setup.${ext}'
      : '${productName}-${version}-Windows-${arch}-Setup.${ext}',
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    deleteAppDataOnUninstall: false,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'NeoDeskPet',
    uninstallDisplayName: 'NeoDeskPet',
    installerIcon: 'build/icon.ico',
    uninstallerIcon: 'build/icon.ico',
    installerHeaderIcon: 'build/icon.ico',
  },
  linux: {
    icon: 'build/icon.png',
    category: 'Utility',
    target: ['AppImage'],
    artifactName: bundleBrowser
      ? '${productName}-${version}-Linux-${arch}-Full.${ext}'
      : '${productName}-${version}-Linux-${arch}.${ext}',
  },
}
