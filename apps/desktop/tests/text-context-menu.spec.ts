/**
 * The Desktop shell's native text context menu.
 *
 * The decision function is pure: it maps the state Electron reports for the
 * clicked element to the menu entries, so every rule below is pinned without a
 * renderer. The attach helper is exercised against a fake window to prove the
 * popup is bound to the window that received the event.
 */
import { describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'

const harness = vi.hoisted(() => ({
  locale: 'en-US',
  buildFromTemplate: vi.fn((template: unknown) => ({ template, popup: vi.fn() })),
}))

vi.mock('electron', () => ({
  Menu: { buildFromTemplate: harness.buildFromTemplate },
  app: { getLocale: () => harness.locale },
}))

const { attachTextContextMenu, textContextMenuEntries } = await import('../src/text-context-menu.ts')

const enabled = { canCut: true, canCopy: true, canPaste: true, canSelectAll: true }
const nothing = { canCut: false, canCopy: false, canPaste: false, canSelectAll: false }

describe('text context menu entries', () => {
  it('offers every editing action plus Select All on an editable selection', () => {
    expect(textContextMenuEntries({ isEditable: true, selectionText: 'abc', editFlags: enabled }))
      .toEqual(['cut', 'copy', 'paste', { type: 'separator' }, 'selectAll'])
  })

  it('keeps Cut and Copy out when the editable field has no selection', () => {
    expect(textContextMenuEntries({
      isEditable: true,
      selectionText: '',
      editFlags: { ...enabled, canCut: false, canCopy: false },
    })).toEqual(['paste', { type: 'separator' }, 'selectAll'])
  })

  it('offers copying alone for a selected read-only text', () => {
    expect(textContextMenuEntries({ isEditable: false, selectionText: 'read me', editFlags: enabled }))
      .toEqual(['copy'])
  })

  it('shows no menu where there is no selection and nothing editable', () => {
    expect(textContextMenuEntries({ isEditable: false, selectionText: '', editFlags: enabled })).toEqual([])
  })

  it('never offers a mutation for a read-only field', () => {
    // A read-only input reports isEditable false but still allows copying.
    const readonly = { canCut: false, canCopy: true, canPaste: false, canSelectAll: true }
    expect(textContextMenuEntries({ isEditable: false, selectionText: 'locked', editFlags: readonly })).toEqual(['copy'])
    expect(textContextMenuEntries({ isEditable: false, selectionText: '', editFlags: readonly })).toEqual([])
  })

  it('offers nothing for a disabled field', () => {
    expect(textContextMenuEntries({ isEditable: false, selectionText: '', editFlags: nothing })).toEqual([])
  })

  it('omits Paste when the clipboard cannot be pasted here', () => {
    const entries = textContextMenuEntries({
      isEditable: true,
      selectionText: 'abc',
      editFlags: { ...enabled, canPaste: false },
    })
    expect(entries).not.toContain('paste')
    expect(entries).toEqual(['cut', 'copy', { type: 'separator' }, 'selectAll'])
  })

  it('offers Select All only while the frame reports it', () => {
    expect(textContextMenuEntries({ isEditable: true, selectionText: '', editFlags: { ...nothing, canPaste: true, canSelectAll: true } }))
      .toEqual(['paste', { type: 'separator' }, 'selectAll'])
    expect(textContextMenuEntries({ isEditable: true, selectionText: '', editFlags: { ...nothing, canPaste: true } }))
      .toEqual(['paste'])
  })
})

describe('attaching the menu to a window', () => {
  function fakeWindow(): { window: BrowserWindow; handlers: { fire: (params: unknown) => void } } {
    const handlers: { fire: (params: unknown) => void } = {
      fire: () => { throw new Error('context-menu handler was not registered') },
    }
    const window = {
      webContents: {
        on: (event: string, handler: (event: unknown, params: unknown) => void) => {
          if (event === 'context-menu') handlers.fire = (params: unknown) => { handler({}, params) }
        },
      },
    } as unknown as BrowserWindow
    return { window, handlers }
  }

  it('pops the event window menu with native edit roles', () => {
    harness.locale = 'en-US'
    harness.buildFromTemplate.mockClear()
    const { window, handlers } = fakeWindow()
    attachTextContextMenu(window)
    handlers.fire({ isEditable: true, selectionText: 'abc', editFlags: enabled })
    expect(harness.buildFromTemplate).toHaveBeenCalledTimes(1)
    expect(harness.buildFromTemplate.mock.calls[0]?.[0]).toEqual([
      { role: 'cut', label: 'Cut' },
      { role: 'copy', label: 'Copy' },
      { role: 'paste', label: 'Paste' },
      { type: 'separator' },
      { role: 'selectAll', label: 'Select All' },
    ])
    const menu = harness.buildFromTemplate.mock.results[0]?.value as { popup: ReturnType<typeof vi.fn> }
    expect(menu.popup).toHaveBeenCalledWith({ window })
  })

  it('labels the menu in the application locale, not in Electron defaults', () => {
    // Electron's own role labels stay English on a Chinese Windows installation,
    // so the Chinese Desktop must be served by the Desktop locale system.
    harness.locale = 'zh-CN'
    harness.buildFromTemplate.mockClear()
    const { window, handlers } = fakeWindow()
    attachTextContextMenu(window)
    handlers.fire({ isEditable: true, selectionText: 'abc', editFlags: enabled })
    expect(harness.buildFromTemplate.mock.calls[0]?.[0]).toEqual([
      { role: 'cut', label: '剪切' },
      { role: 'copy', label: '复制' },
      { role: 'paste', label: '粘贴' },
      { type: 'separator' },
      { role: 'selectAll', label: '全选' },
    ])
    harness.locale = 'en-US'
  })

  it.each([
    { label: 'plain text with no selection', params: { isEditable: false, selectionText: '', editFlags: enabled } },
    { label: 'a disabled field', params: { isEditable: false, selectionText: '', editFlags: nothing } },
  ])('shows no menu for $label', ({ params }) => {
    harness.buildFromTemplate.mockClear()
    const { window, handlers } = fakeWindow()
    attachTextContextMenu(window)
    handlers.fire(params)
    expect(harness.buildFromTemplate).not.toHaveBeenCalled()
  })
})
