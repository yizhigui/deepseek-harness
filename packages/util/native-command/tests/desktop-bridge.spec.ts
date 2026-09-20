/**
 * The process-wide carrier for a shell-owned native opener. A Host process has
 * no display of its own, so the registry is the only way the path openers learn
 * that a GUI shell is present, and a disposer has to put the process back the
 * way it found it for nested shells and for tests that drive both.
 */

import { describe, expect, it } from 'vitest'
import { nativeDesktopBridge, registerNativeDesktopBridge, type NativeDesktopBridge } from '../src/index.ts'

/** A bridge whose operations record nothing: the registry only carries identity. */
function bridge(): NativeDesktopBridge {
  return { reveal: async () => {}, open: async () => {} }
}

describe('native desktop bridge registry', () => {
  it('reads no bridge before a shell registers one', () => {
    expect(nativeDesktopBridge()).toBeUndefined()
  })

  it('publishes the registered bridge and clears it on release', () => {
    const registered = bridge()
    const release = registerNativeDesktopBridge(registered)
    try {
      expect(nativeDesktopBridge()).toBe(registered)
    } finally {
      release()
    }
    expect(nativeDesktopBridge()).toBeUndefined()
  })

  it('restores the previous registration when a nested shell releases', () => {
    const outer = bridge()
    const inner = bridge()
    const releaseOuter = registerNativeDesktopBridge(outer)
    const releaseInner = registerNativeDesktopBridge(inner)
    try {
      expect(nativeDesktopBridge()).toBe(inner)
    } finally {
      releaseInner()
    }
    expect(nativeDesktopBridge()).toBe(outer)
    releaseOuter()
    expect(nativeDesktopBridge()).toBeUndefined()
  })
})
