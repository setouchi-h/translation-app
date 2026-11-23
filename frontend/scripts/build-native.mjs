// Builds the macOS helper that captures per-app audio into resources/bin.
// Does nothing on other platforms, where the app falls back to input devices.
//
// Builds for this machine's architecture only. A universal build needs a second swiftc
// run for the other architecture and `lipo -create` to join the two.

import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'darwin') {
  console.log('build-native: skipped (macOS only)')
  process.exit(0)
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outputDirectory = join(root, 'resources', 'bin')
const output = join(outputDirectory, 'app-audio-tap')
const architecture = process.arch === 'arm64' ? 'arm64' : 'x86_64'

mkdirSync(outputDirectory, { recursive: true })
execFileSync(
  'xcrun',
  [
    'swiftc',
    '-O',
    '-swift-version',
    '5',
    '-target',
    // Core Audio process taps arrived in macOS 14.2.
    `${architecture}-apple-macos14.2`,
    join(root, 'native', 'mac', 'AppAudioTap.swift'),
    '-o',
    output
  ],
  { stdio: 'inherit' }
)

console.log(`build-native: built ${output}`)
