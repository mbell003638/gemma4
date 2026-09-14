import fs from 'fs';
import path from 'path';

const android = path.resolve(__dirname, '../modules/ledgr-native-ai/android');
const read = (file: string) => fs.readFileSync(path.join(android, file), 'utf8');

test('default native source tree excludes the SDK and selects the legacy bridge', () => {
  const build = read('build.gradle');
  expect(build).toContain("project.findProperty('ledgrGemmaEnabled') == 'true'");
  expect(build).toContain("gemmaEnabled ? ['src/gemma/java'] : ['src/legacy/java']");
  expect(build).toMatch(/if \(gemmaEnabled\)\s*\{\s*implementation 'com\.google\.ai\.edge\.litertlm:litertlm-android:0\.17\.0'/);
  const main = path.join(android, 'src/main/java/expo/modules/ledgrnativeai');
  for (const file of fs.readdirSync(main).filter((name) => name.endsWith('.kt'))) {
    expect(fs.readFileSync(path.join(main, file), 'utf8')).not.toMatch(/com\.google\.ai\.edge\.litertlm|GemmaSessionHost/);
  }
  const legacy = read('src/legacy/java/expo/modules/ledgrnativeai/LedgrOnDeviceLlmModule.kt');
  expect(legacy).toContain('needle2.cact');
  expect(legacy).not.toContain('GemmaSessionHost');
  expect(read('src/gemma/java/expo/modules/ledgrnativeai/LedgrOnDeviceLlmModule.kt')).toContain('Name("LedgrOnDeviceLlm")');
});
