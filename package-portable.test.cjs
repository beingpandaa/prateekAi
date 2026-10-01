'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const RE = require('resedit');
const { APP_FILES, destinationFor, brandExecutable } = require('./package-portable.cjs');
test('packaging cannot overwrite an existing destination or source directory', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prateekai-package-test-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sentinel = path.join(root, 'do-not-change.txt'); fs.writeFileSync(sentinel, 'existing build');
  assert.throws(() => destinationFor(root), /already exists/); assert.throws(() => destinationFor(__dirname), /separate/); assert.equal(fs.readFileSync(sentinel, 'utf8'), 'existing build');
});
test('application package allowlist includes profile module and branding but no private or test artifacts', () => {
  for (const file of ['profile.cjs', 'assets/prateekAi.ico', 'assets/prateekAi.png', 'content.js']) assert.ok(APP_FILES.includes(file));
  for (const file of APP_FILES) { assert.ok(fs.statSync(path.join(__dirname, file)).isFile()); assert.ok(!/(?:settings\.json|\.env|test|profile\/|logs?\/)/i.test(file)); }
});
test('icon contains readable Windows sizes from16px to256px', () => {
  const icons = RE.Data.IconFile.from(fs.readFileSync(path.join(__dirname, 'assets/prateekAi.ico')));
  assert.deepEqual(icons.icons.map(icon => icon.data.width), [16, 24, 32, 48, 64, 128, 256]);
});
test('Windows executable branding updates version resources and embeds the supplied icons', { skip: process.platform !== 'win32' }, t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'prateekai-exe-test-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'prateekAi.exe'), original = fs.readFileSync(require('electron'));
  fs.writeFileSync(file, original); brandExecutable(file, { version: '1.2.3' }, path.join(__dirname, 'assets/prateekAi.ico'));
  const executable = RE.NtExecutable.from(fs.readFileSync(file)), resource = RE.NtExecutableResource.from(executable);
  const before = RE.NtExecutable.from(original, { ignoreCert: true });
  assert.equal(executable.newHeader.optionalHeader.addressOfEntryPoint, before.newHeader.optionalHeader.addressOfEntryPoint);
  const versions = RE.Resource.VersionInfo.fromEntries(resource.entries);
  for (const version of versions) for (const language of version.getAllLanguagesForStringValues()) {
    const values = version.getStringValues(language); assert.equal(values.ProductName, 'prateekAi'); assert.equal(values.FileDescription, 'prateekAi'); assert.equal(values.OriginalFilename, 'prateekAi.exe'); assert.equal(values.ProductVersion, '1.2.3');
  }
  for (const group of RE.Resource.IconGroupEntry.fromEntries(resource.entries)) assert.deepEqual(group.icons.map(icon => icon.width || 256), [16, 24, 32, 48, 64, 128, 256]);
});
