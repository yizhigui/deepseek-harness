/** Native text context menu shared by every Desktop window. */

import { app, Menu, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'
import { resolveDesktopLocale } from './locale.ts'

/** One editing action the shell may offer. */
export type TextContextAction = 'cut' | 'copy' | 'paste' | 'selectAll'

/** Locale key that names each action for the user. */
const ACTION_LABELS: Readonly<Record<TextContextAction, 'contextCut' | 'contextCopy' | 'contextPaste' | 'contextSelectAll'>> = {
  cut: 'contextCut',
  copy: 'contextCopy',
  paste: 'contextPaste',
  selectAll: 'contextSelectAll',
}

/** Group boundary between the editing actions and the selection action. */
export interface TextContextSeparator {
  readonly type: 'separator'
}

/** One entry of the text menu, in display order. */
export type TextContextEntry = TextContextAction | TextContextSeparator

/**
 * The context state this module is allowed to depend on.
 *
 * These are exactly the fields Electron reports for the element under the
 * pointer, so no DOM shape is guessed from the renderer.
 */
export interface TextContextState {
  readonly isEditable: boolean
  readonly selectionText: string
  readonly editFlags: {
    readonly canCut: boolean
    readonly canCopy: boolean
    readonly canPaste: boolean
    readonly canSelectAll: boolean
  }
}

/**
 * Decide the text menu for one right-click.
 *
 * The edit flags describe what the focused frame can really do, so a read-only
 * or disabled field never offers a mutation, an empty editable field still
 * offers pasting, and a plain text selection offers copying alone. An area with
 * nothing this menu supports produces no entries, and therefore no menu.
 * @param state - Electron's reported state for the clicked element.
 * @returns Entries in display order; empty when the shell should show no menu.
 */
export function textContextMenuEntries(state: TextContextState): readonly TextContextEntry[] {
  const { canCut, canCopy, canPaste, canSelectAll } = state.editFlags
  if (state.isEditable) {
    const entries: TextContextEntry[] = []
    if (canCut) entries.push('cut')
    if (canCopy) entries.push('copy')
    if (canPaste) entries.push('paste')
    // Select All stands on its own only when no editing action is available.
    if (entries.length === 0) return canSelectAll ? ['selectAll'] : []
    if (canSelectAll) entries.push({ type: 'separator' }, 'selectAll')
    return entries
  }
  // Read-only text is still readable text: copying is the only supported action.
  return canCopy && state.selectionText !== '' ? ['copy'] : []
}

/**
 * Give one window the shared native text menu.
 *
 * Every Desktop window is created by one factory, so attaching here covers the
 * application document, the plugin-manager window and any window added later.
 * The listener lives on the window's own web contents and dies with it. Roles
 * are Electron's own, so the items act on the focused frame; the visible labels
 * come from the Desktop locale system, because Electron's built-in role labels
 * are not localized on a Chinese Windows installation.
 * @param window - Window whose web contents own the context-menu events.
 */
export function attachTextContextMenu(window: BrowserWindow): void {
  window.webContents.on('context-menu', (_event, params) => {
    const entries = textContextMenuEntries(params)
    if (entries.length === 0) return
    const messages = resolveDesktopLocale(app.getLocale()).messages
    const template: MenuItemConstructorOptions[] = entries.map(entry => (
      typeof entry === 'string' ? { role: entry, label: messages[ACTION_LABELS[entry]] } : { type: 'separator' }
    ))
    Menu.buildFromTemplate(template).popup({ window })
  })
}
