'use strict';
// Run after pnpm install. Production package contains no keys, profiles or logs.
const fs = require('node:fs');
const path = require('node:path');
const destination = path.resolve(process.argv[2] || path.join(__dirname, '..', '..', 'outputs', 'prateekAi'));
if (destination === __dirname || destination === path.parse(destination).root) throw new Error('Choose a separate output folder.');
const runtime = path.join(path.dirname(require.resolve('electron/package.json')), 'dist');
if (!fs.existsSync(path.join(runtime, 'electron.exe'))) throw new Error('Install the Windows Electron runtime first.');
fs.mkdirSync(destination, { recursive: true });
fs.cpSync(runtime, destination, { recursive: true, dereference: true });
const appDir = path.join(destination, 'resources', 'app');
fs.mkdirSync(appDir, { recursive: true });
for (const name of ['main.cjs', 'preload.cjs', 'providers.cjs', 'provider-adapters.cjs', 'routing.cjs', 'speech.cjs', 'turns.cjs', 'oauth.cjs', 'index.html', 'style.css', 'renderer.js', 'content.html', 'content.js', 'content.css', 'pcm-worklet.js']) {
  fs.copyFileSync(path.join(__dirname, name), path.join(appDir, name));
}
const metadata = require('./package.json');
delete metadata.devDependencies; delete metadata.scripts;
fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify(metadata, null, 2));
for (const dependency of ['ws', 'jose']) {
  const source = fs.realpathSync(path.join(__dirname, 'node_modules', dependency));
  fs.cpSync(source, path.join(appDir, 'node_modules', dependency), { recursive: true, dereference: true });
}
fs.copyFileSync(path.join(destination, 'electron.exe'), path.join(destination, 'prateekAi.exe'));
fs.unlinkSync(path.join(destination, 'electron.exe'));
fs.writeFileSync(path.join(destination, 'README.txt'), `PRATEEKAI ${metadata.version} — WINDOWS PORTABLE APP\n\nExtract the complete folder and run prateekAi.exe. Keep its accompanying files.\nNode, Chromium and the app dependencies are included.\n\nConnect your own answer provider and Deepgram speech key in Setup, then save.\nChoose Mic practice or Live call, enable Auto-answer, then Start listening.\nThe separate answer window opens after audio connects. Its offline example\nworks without accounts or usage charges. Real AI and speech usage may cost money.\n\nResize the answer window with its bottom-right grip. The ... menu opens reading\ncontrols or Setup. Closing the popup stops listening; hiding it does not.\nStop listening when finished. Close older running versions before reopening.\n\nSettings/keys are stored separately in your Windows user profile. No accounts\nor personal context are distributed with this app. Each user connects their own.\nVerify the view received from a second device before relying on screen exclusion.\n`);
console.log(`Portable app: ${path.join(destination, 'prateekAi.exe')}`);
