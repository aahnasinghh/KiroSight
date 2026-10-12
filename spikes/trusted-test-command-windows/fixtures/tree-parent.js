// Spike C fixture B: parent that starts a nested child; both stay alive.
const { spawn } = require('node:child_process');
const path = require('node:path');

console.log(`PARENT_PID=${process.pid}`);
const child = spawn(process.execPath, [path.join(__dirname, 'tree-child.js')], {
  stdio: ['ignore', 'inherit', 'inherit'],
  windowsHide: true,
});
console.log(`CHILD_PID_FROM_PARENT=${child.pid}`);
setInterval(() => undefined, 1000);
