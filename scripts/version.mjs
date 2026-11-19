// Prints the app version and fails when the two places that hold it disagree.
// package.json is the source of truth (src-tauri/tauri.conf.json reads it); Cargo.toml must match.
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const cargo = readFileSync(new URL('../src-tauri/Cargo.toml', import.meta.url), 'utf8')
  .match(/^\[package\][^[]*?^version\s*=\s*"([^"]+)"/m)?.[1];

if (pkg !== cargo) {
  console.error(`Version mismatch: package.json has ${pkg}, src-tauri/Cargo.toml has ${cargo}`);
  process.exit(1);
}
console.log(pkg);
