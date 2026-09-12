import { useEffect, useRef, type RefObject } from 'react';

export interface PaginationHotkeyEntry {
  id: number;
  elementRef: RefObject<HTMLElement | null>;
  canGoPrevious: boolean;
  canGoNext: boolean;
  onPreviousPage: () => void;
  onNextPage: () => void;
  enabled: boolean;
}

export interface UsePaginationHotkeysOptions {
  containerRef: RefObject<HTMLElement | null>;
  canGoPrevious: boolean;
  canGoNext: boolean;
  onPreviousPage: () => void;
  onNextPage: () => void;
  enabled?: boolean;
}

const paginationHotkeysStack: PaginationHotkeyEntry[] = [];
let nextPaginationHotkeyId = 1;
let globalListenerAttached = false;

export function shouldIgnoreHotkeyTarget(target: unknown): boolean {
  if (!target || !(target instanceof Object)) return false;
  const element = target as {
    tagName?: string;
    isContentEditable?: boolean;
    getAttribute?: (attr: string) => string | null;
  };

  if (element.isContentEditable) {
    return true;
  }

  const tagName = typeof element.tagName === 'string' ? element.tagName.toUpperCase() : '';
  if (tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT') {
    return true;
  }

  if (typeof element.getAttribute === 'function') {
    const role = element.getAttribute('role');
    if (role === 'textbox') {
      return true;
    }
  }

  return false;
}

export function isElementVisible(element: HTMLElement | null): boolean {
  if (!element) return false;
  if (!element.isConnected) return false;

  // Modern browsers support checkVisibility
  if (typeof (element as unknown as { checkVisibility?: (opts: object) => boolean }).checkVisibility === 'function') {
    try {
      const visible = (element as unknown as { checkVisibility: (opts: object) => boolean }).checkVisibility({
        checkOpacity: false,
        checkVisibilityCSS: false,
      });
      if (!visible) return false;
    } catch {
      // fallback if checkVisibility throws
    }
  }

  if (element.offsetParent !== null) {
    return true;
  }

  if (typeof element.getClientRects === 'function') {
    const rects = element.getClientRects();
    if (rects.length > 0 && (rects[0].width > 0 || rects[0].height > 0)) {
      return true;
    }
  }

  let current: HTMLElement | null = element;
  while (current) {
    if (current.style && current.style.display === 'none') {
      return false;
    }
    current = current.parentElement;
  }

  return true;
}

function isHtmlElementLike(value: unknown): value is HTMLElement {
  if (!value || typeof value !== 'object') return false;
  if (typeof HTMLElement !== 'undefined') {
    return value instanceof HTMLElement;
  }
  return typeof (value as { nodeType?: unknown }).nodeType === 'number' || 'tagName' in value;
}

export function findActivePaginationEntry(
  entries: readonly PaginationHotkeyEntry[],
  activeElement: Element | null,
): PaginationHotkeyEntry | null {
  const visibleEntries = entries.filter(
    (entry) => entry.enabled && isElementVisible(entry.elementRef.current),
  );

  if (visibleEntries.length === 0) {
    return null;
  }

  if (isHtmlElementLike(activeElement)) {
    // 1. If activeElement is directly inside a pagination entry container
    const directMatch = visibleEntries.find(
      (entry) => entry.elementRef.current && entry.elementRef.current.contains(activeElement),
    );
    if (directMatch) return directMatch;

    // 2. If activeElement is inside a dialog/modal, prefer the entry in that dialog/modal
    const activeDialog =
      typeof activeElement.closest === 'function'
        ? activeElement.closest(
            '[role="dialog"], dialog, .modal, .modal-content, .modal-container, .codex-modal',
          )
        : null;
    if (activeDialog) {
      const dialogMatch = [...visibleEntries].reverse().find((entry) => {
        const entryEl = entry.elementRef.current;
        return entryEl && activeDialog.contains(entryEl);
      });
      if (dialogMatch) return dialogMatch;
    }
  }

  // 3. Prefer entries that reside within an open dialog/modal over background pages
  const modalEntry = [...visibleEntries].reverse().find((entry) => {
    const entryEl = entry.elementRef.current;
    return (
      entryEl &&
      typeof entryEl.closest === 'function' &&
      Boolean(
        entryEl.closest(
          '[role="dialog"], dialog, .modal, .modal-content, .modal-container, .codex-modal',
        ),
      )
    );
  });
  if (modalEntry) return modalEntry;

  // 4. Fallback to latest registered visible entry (LIFO)
  return visibleEntries[visibleEntries.length - 1] ?? null;
}

export function dispatchPaginationHotkey(
  event: Pick<
    KeyboardEvent,
    | 'key'
    | 'defaultPrevented'
    | 'shiftKey'
    | 'ctrlKey'
    | 'metaKey'
    | 'altKey'
    | 'isComposing'
    | 'target'
  > & {
    keyCode?: number;
    preventDefault?: () => void;
    stopImmediatePropagation?: () => void;
  },
  entries: readonly PaginationHotkeyEntry[],
  activeElement: Element | null,
): boolean {
  if (event.key !== 'PageUp' && event.key !== 'PageDown') {
    return false;
  }
  if (event.defaultPrevented) {
    return false;
  }
  if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) {
    return false;
  }
  if (event.isComposing || event.keyCode === 229) {
    return false;
  }
  if (shouldIgnoreHotkeyTarget(event.target)) {
    return false;
  }

  const activeEntry = findActivePaginationEntry(entries, activeElement);
  if (!activeEntry) {
    return false;
  }

  if (typeof event.preventDefault === 'function') {
    event.preventDefault();
  }
  if (typeof event.stopImmediatePropagation === 'function') {
    event.stopImmediatePropagation();
  }

  if (event.key === 'PageUp') {
    if (activeEntry.canGoPrevious) {
      activeEntry.onPreviousPage();
    }
    return true;
  }

  if (event.key === 'PageDown') {
    if (activeEntry.canGoNext) {
      activeEntry.onNextPage();
    }
    return true;
  }

  return false;
}

function handleGlobalPaginationKeyDown(event: KeyboardEvent) {
  const activeElement = typeof document !== 'undefined' ? document.activeElement : null;
  dispatchPaginationHotkey(event, paginationHotkeysStack, activeElement);
}

function ensureGlobalListener() {
  if (globalListenerAttached) return;
  if (typeof window === 'undefined') return;
  window.addEventListener('keydown', handleGlobalPaginationKeyDown, true);
  globalListenerAttached = true;
}

function teardownGlobalListenerIfIdle() {
  if (paginationHotkeysStack.length > 0 || !globalListenerAttached) return;
  if (typeof window === 'undefined') return;
  window.removeEventListener('keydown', handleGlobalPaginationKeyDown, true);
  globalListenerAttached = false;
}

export function usePaginationHotkeys({
  containerRef,
  canGoPrevious,
  canGoNext,
  onPreviousPage,
  onNextPage,
  enabled = true,
}: UsePaginationHotkeysOptions) {
  const optionsRef = useRef({
    canGoPrevious,
    canGoNext,
    onPreviousPage,
    onNextPage,
    enabled,
  });

  optionsRef.current = {
    canGoPrevious,
    canGoNext,
    onPreviousPage,
    onNextPage,
    enabled,
  };

  useEffect(() => {
    if (!enabled) return;

    const entry: PaginationHotkeyEntry = {
      id: nextPaginationHotkeyId++,
      elementRef: containerRef,
      get canGoPrevious() {
        return optionsRef.current.canGoPrevious;
      },
      get canGoNext() {
        return optionsRef.current.canGoNext;
      },
      onPreviousPage: () => optionsRef.current.onPreviousPage(),
      onNextPage: () => optionsRef.current.onNextPage(),
      get enabled() {
        return optionsRef.current.enabled;
      },
    };

    paginationHotkeysStack.push(entry);
    ensureGlobalListener();

    return () => {
      const index = paginationHotkeysStack.findIndex((item) => item.id === entry.id);
      if (index >= 0) {
        paginationHotkeysStack.splice(index, 1);
      }
      teardownGlobalListenerIfIdle();
    };
  }, [containerRef, enabled]);
}
