'use strict';

// electron-builder afterPack hook: runs on the unpacked app before it is
// signed or put into an installer.
//
// Removes dxcompiler.dll, the DirectX 12 shader compiler Electron ships for
// WebGPU. It is unsigned, so Smart App Control blocks it when the GPU process
// tries to load it and Windows shows "Part of this app has been blocked". The
// maps draw with WebGL (MapLibre) and nothing here uses WebGPU, so without the
// file the GPU process simply has no WebGPU on Direct3D 12.

const fs = require('fs');
const path = require('path');

const REMOVE = ['dxcompiler.dll'];

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  for (const name of REMOVE) {
    const file = path.join(context.appOutDir, name);
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
      console.log(`  • after-pack: removed ${name}`);
    }
  }
};
