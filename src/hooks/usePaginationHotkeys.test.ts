import assert from 'node:assert/strict';
import test from 'node:test';
import {
  dispatchPaginationHotkey,
  findActivePaginationEntry,
  shouldIgnoreHotkeyTarget,
  type PaginationHotkeyEntry,
} from './usePaginationHotkeys.ts';

function createMockEntry(overrides?: Partial<PaginationHotkeyEntry>): PaginationHotkeyEntry {
  const mockElement = {
    isConnected: true,
    offsetParent: {},
    style: { display: '' },
    getClientRects: () => [{ width: 100, height: 100 }],
    contains: () => false,
    closest: () => null,
  } as unknown as HTMLElement;

  return {
    id: 1,
    elementRef: { current: mockElement },
    canGoPrevious: true,
    canGoNext: true,
    onPreviousPage: () => {},
    onNextPage: () => {},
    enabled: true,
    ...overrides,
  };
}

test('shouldIgnoreHotkeyTarget detects text input targets', () => {
  assert.equal(shouldIgnoreHotkeyTarget(null), false);
  assert.equal(shouldIgnoreHotkeyTarget({ tagName: 'DIV' }), false);
  assert.equal(shouldIgnoreHotkeyTarget({ tagName: 'BUTTON' }), false);

  assert.equal(shouldIgnoreHotkeyTarget({ tagName: 'INPUT' }), true);
  assert.equal(shouldIgnoreHotkeyTarget({ tagName: 'TEXTAREA' }), true);
  assert.equal(shouldIgnoreHotkeyTarget({ tagName: 'SELECT' }), true);
  assert.equal(shouldIgnoreHotkeyTarget({ isContentEditable: true }), true);
  assert.equal(
    shouldIgnoreHotkeyTarget({
      tagName: 'DIV',
      getAttribute: (attr: string) => (attr === 'role' ? 'textbox' : null),
    }),
    true,
  );
});

test('dispatchPaginationHotkey ignores modifier keys and non-PageUp/Down keys', () => {
  let prevCalled = false;
  let nextCalled = false;

  const entry = createMockEntry({
    onPreviousPage: () => {
      prevCalled = true;
    },
    onNextPage: () => {
      nextCalled = true;
    },
  });

  // Non-target keys
  assert.equal(
    dispatchPaginationHotkey(
      { key: 'ArrowDown', defaultPrevented: false, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, isComposing: false, target: null },
      [entry],
      null,
    ),
    false,
  );

  // Shift + PageDown
  assert.equal(
    dispatchPaginationHotkey(
      { key: 'PageDown', defaultPrevented: false, shiftKey: true, ctrlKey: false, metaKey: false, altKey: false, isComposing: false, target: null },
      [entry],
      null,
    ),
    false,
  );

  // Ctrl + PageUp
  assert.equal(
    dispatchPaginationHotkey(
      { key: 'PageUp', defaultPrevented: false, shiftKey: false, ctrlKey: true, metaKey: false, altKey: false, isComposing: false, target: null },
      [entry],
      null,
    ),
    false,
  );

  assert.equal(prevCalled, false);
  assert.equal(nextCalled, false);
});

test('dispatchPaginationHotkey triggers onNextPage on PageDown and prevents default', () => {
  let nextCalled = false;
  let prevented = false;

  const entry = createMockEntry({
    canGoNext: true,
    onNextPage: () => {
      nextCalled = true;
    },
  });

  const handled = dispatchPaginationHotkey(
    {
      key: 'PageDown',
      defaultPrevented: false,
      shiftKey: false,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      isComposing: false,
      target: { tagName: 'DIV' } as unknown as EventTarget,
      preventDefault: () => {
        prevented = true;
      },
    },
    [entry],
    null,
  );

  assert.equal(handled, true);
  assert.equal(nextCalled, true);
  assert.equal(prevented, true);
});

test('dispatchPaginationHotkey triggers onPreviousPage on PageUp when canGoPrevious is true', () => {
  let prevCalled = false;
  let prevented = false;

  const entry = createMockEntry({
    canGoPrevious: true,
    onPreviousPage: () => {
      prevCalled = true;
    },
  });

  const handled = dispatchPaginationHotkey(
    {
      key: 'PageUp',
      defaultPrevented: false,
      shiftKey: false,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      isComposing: false,
      target: { tagName: 'BUTTON' } as unknown as EventTarget,
      preventDefault: () => {
        prevented = true;
      },
    },
    [entry],
    null,
  );

  assert.equal(handled, true);
  assert.equal(prevCalled, true);
  assert.equal(prevented, true);
});

test('dispatchPaginationHotkey prevents default even when at edge (canGoNext=false) without triggering callback', () => {
  let nextCalled = false;
  let prevented = false;

  const entry = createMockEntry({
    canGoNext: false,
    onNextPage: () => {
      nextCalled = true;
    },
  });

  const handled = dispatchPaginationHotkey(
    {
      key: 'PageDown',
      defaultPrevented: false,
      shiftKey: false,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      isComposing: false,
      target: null,
      preventDefault: () => {
        prevented = true;
      },
    },
    [entry],
    null,
  );

  assert.equal(handled, true);
  assert.equal(nextCalled, false);
  assert.equal(prevented, true);
});

test('findActivePaginationEntry chooses modal entry over background entry', () => {
  const bgElement = {
    isConnected: true,
    offsetParent: {},
    style: { display: '' },
    getClientRects: () => [{ width: 100, height: 100 }],
    closest: () => null,
  } as unknown as HTMLElement;

  const modalElement = {
    isConnected: true,
    offsetParent: {},
    style: { display: '' },
    getClientRects: () => [{ width: 100, height: 100 }],
    closest: (selector: string) => (selector.includes('modal') ? {} : null),
  } as unknown as HTMLElement;

  const bgEntry = createMockEntry({ id: 1, elementRef: { current: bgElement } });
  const modalEntry = createMockEntry({ id: 2, elementRef: { current: modalElement } });

  const active = findActivePaginationEntry([bgEntry, modalEntry], null);
  assert.equal(active?.id, 2);
});
