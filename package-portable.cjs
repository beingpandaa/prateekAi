'use strict';
// Allowlist application assets; never traverse a user profile or copy source logs.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const APP_FILES = Object.freeze(['main.cjs', 'preload.cjs', 'profile.cjs', 'voice-fallback.cjs', 'providers.cjs', 'provider-adapters.cjs', 'routing.cjs', 'speech.cjs', 'turns.cjs', 'oauth.cjs', 'index.html', 'style.css', 'renderer.js', 'content.html', 'content.js', 'content.css', 'pcm-worklet.js', 'assets/prateekAi.ico', 'assets/prateekAi.png']);
const RUNTIME_FILES = Object.freeze(['chrome_100_percent.pak', 'chrome_200_percent.pak', 'd3dcompiler_47.dll', 'dxcompiler.dll', 'dxil.dll', 'electron.exe', 'ffmpeg.dll', 'icudtl.dat', 'libEGL.dll', 'libGLESv2.dll', 'LICENSE', 'LICENSES.chromium.html', 'resources.pak', 'snapshot_blob.bin', 'v8_context_snapshot.bin', 'vk_swiftshader.dll', 'vk_swiftshader_icd.json', 'vulkan-1.dll']);
function destinationFor(destination) {
  const resolved = path.resolve(destination), relative = path.relative(__dirname, resolved);
  if (!relative || relative === '..' || resolved === path.parse(resolved).root) throw new Error('Choose a separate, new output directory.');
  if (fs.existsSync(resolved)) throw new Error('The output directory already exists. Choose a new destination; existing builds are never overwritten.');
  return resolved;
}
function brandExecutable(file, metadata, iconFile) {
  const RE = require('resedit');
  // Branding changes invalidate the upstream signature. This build is unsigned;
  // a release publisher can sign the resulting executable after packaging.
  const executable = RE.NtExecutable.from(fs.readFileSync(file), { ignoreCert: true });
  const resource = RE.NtExecutableResource.from(executable);
  const versions = RE.Resource.VersionInfo.fromEntries(resource.entries);
  if (!versions.length) throw new Error('The Electron runtime has no version resource.');
  for (const version of versions) {
    version.setFileVersion(`${metadata.version}.0`); version.setProductVersion(`${metadata.version}.0`);
    const languages = version.getAllLanguagesForStringValues();
    for (const language of languages.length ? languages : [{ lang: 1033, codepage: 1200 }]) version.setStringValues(language, {
      FileDescription: 'prateekAi', ProductName: 'prateekAi', CompanyName: 'prateekAi contributors', InternalName: 'prateekAi', OriginalFilename: 'prateekAi.exe',
      ProductVersion: metadata.version, FileVersion: `${metadata.version}.0`, LegalCopyright: 'prateekAi contributors. Electron notices are included.'
    });
    version.outputToResourceEntries(resource.entries);
  }
  const icons = RE.Data.IconFile.from(fs.readFileSync(iconFile));
  const groups = RE.Resource.IconGroupEntry.fromEntries(resource.entries);
  if (!groups.length) throw new Error('The Electron runtime has no application icon resource.');
  for (const group of groups) RE.Resource.IconGroupEntry.replaceIconsForResource(resource.entries, group.id, group.lang, icons.icons.map(item => item.data));
  resource.outputResource(executable); fs.writeFileSync(file, Buffer.from(executable.generate()));
  const verified = RE.NtExecutableResource.from(RE.NtExecutable.from(fs.readFileSync(file)));
  const result = RE.Resource.VersionInfo.fromEntries(verified.entries)[0];
  const strings = result.getStringValues(result.getAllLanguagesForStringValues()[0]);
  if (strings.ProductName !== 'prateekAi' || strings.OriginalFilename !== 'prateekAi.exe') throw new Error('Executable branding verification failed.');
}
function portableReadme(version) {
  return `prateekAi ${version} — Windows portable app\n\nExtract the complete folder and run prateekAi.exe. Keep its accompanying files.\nNode, Chromium and runtime dependencies are included.\n\nOpen Setup, connect your answer provider and Deepgram speech key, then save.\nChoose Mic practice or Live call, enable Auto-answer, then Start listening.\nThe answer window also has an offline example without accounts or usage charges.\nReal AI and speech usage may cost money. Stop listening when finished.\n\nVoice fallback ships off: enable it in Setup > Answers to submit the pending\nquestion by saying Give me a minute to think. Live-call voice fallback opens\na microphone speech stream unless it is already included. Pause system music\nfor real call tests; system playback is captured.\n\nExperimental build: live speech, answer quality and Meet receiver-side checks\nare not yet qualified. Offline tests do not prove these capabilities.\n\nResize answers using the bottom-right grip; focused arrow keys resize by 20px.\nIts menu opens reading controls or Setup. Closing answers stops listening;\nhiding the window does not. Check screen sharing from your second device.\n\nClose older versions before starting this build. Existing Callside profiles\nremain in place; fresh installations use %APPDATA%\\prateekAi. Saved credentials\nare encrypted for the current Windows account and are never bundled here.\nAn unreadable profile is preserved and cannot be overwritten through Save.\n\nThis development build is unsigned. Repository and source:\nhttps://github.com/beingpandaa/prateekAi\n`;
}
function packagePortable(destination = path.join(__dirname, 'dist', 'prateekAi-win32-x64')) {
  if (process.platform !== 'win32') throw new Error('Build the Windows portable app on Windows.');
  const output = destinationFor(destination), metadata = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
  const runtime = path.join(path.dirname(require.resolve('electron/package.json')), 'dist');
  for (const file of APP_FILES) if (!fs.statSync(path.join(__dirname, file)).isFile()) throw new Error(`Missing application asset: ${file}`);
  if (!fs.existsSync(path.join(runtime, 'electron.exe'))) throw new Error('Install the pinned Windows Electron runtime first.');
  const parent = path.dirname(output), stage = path.join(parent, `.prateekAi-build-${crypto.randomUUID()}`);
  fs.mkdirSync(parent, { recursive: true }); fs.mkdirSync(stage);
  try {
    for (const file of RUNTIME_FILES) if (fs.existsSync(path.join(runtime, file))) fs.copyFileSync(path.join(runtime, file), path.join(stage, file));
    fs.cpSync(path.join(runtime, 'locales'), path.join(stage, 'locales'), { recursive: true, dereference: true });
    const appDir = path.join(stage, 'resources', 'app'); fs.mkdirSync(appDir, { recursive: true });
    for (const file of APP_FILES) { const target = path.join(appDir, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(path.join(__dirname, file), target); }
    const packaged = { name: metadata.name, productName: metadata.productName, version: metadata.version, private: true, description: metadata.description, main: metadata.main, repository: metadata.repository, dependencies: metadata.dependencies };
    fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify(packaged, null, 2));
    for (const dependency of ['ws', 'jose']) fs.cpSync(fs.realpathSync(path.join(__dirname, 'node_modules', dependency)), path.join(appDir, 'node_modules', dependency), { recursive: true, dereference: true });
    const executable = path.join(stage, 'prateekAi.exe'); fs.renameSync(path.join(stage, 'electron.exe'), executable);
    brandExecutable(executable, metadata, path.join(__dirname, 'assets', 'prateekAi.ico'));
    fs.writeFileSync(path.join(stage, 'README.txt'), portableReadme(metadata.version));
    const manifest = { product: 'prateekAi', version: metadata.version, electronVersion: require('electron/package.json').version, nodeBuildVersion: process.version, unsigned: true,
      files: APP_FILES.map(file => ({ file: `resources/app/${file}`, sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(appDir, file))).digest('hex') })) };
    fs.writeFileSync(path.join(stage, 'build-manifest.json'), JSON.stringify(manifest, null, 2));
    if (fs.existsSync(output)) throw new Error('The destination appeared during packaging. Nothing was overwritten.');
    fs.renameSync(stage, output); return output;
  } catch (error) {
    // Only this invocation's fresh staging directory can be removed.
    if (path.dirname(stage) === parent && path.basename(stage).startsWith('.prateekAi-build-')) fs.rmSync(stage, { recursive: true, force: true });
    throw error;
  }
}
if (require.main === module) {
  try { console.log(`Portable app: ${path.join(packagePortable(process.argv[2]), 'prateekAi.exe')}`); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { APP_FILES, RUNTIME_FILES, destinationFor, brandExecutable, packagePortable };
