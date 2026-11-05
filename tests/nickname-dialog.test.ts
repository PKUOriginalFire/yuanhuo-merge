// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { UI } from '../web/src/ui/ui';

let ui: UI;
beforeEach(() => { document.body.innerHTML = readFileSync('web/index.html', 'utf8'); ui = new UI(); });
afterEach(() => ui.resolveNick(null));
const button = (id: string) => {
  const element = document.getElementById(id) as HTMLButtonElement;
  expect(element, `missing #${id}`).not.toBeNull(); return element;
};

it('keeps the dialog open on an empty save, including invisible text, and focuses the input', async () => {
  const done = vi.fn(); void ui.askNickname(2, '').then(done);
  ui.el.nickInput.value = ' \u200b '; button('btn-nick-ok').click(); await Promise.resolve();
  expect(done).not.toHaveBeenCalled(); expect(ui.el.modalNick.classList.contains('hidden')).toBe(false);
  expect(ui.el.nickHint.textContent).toContain('请输入昵称');
  expect(ui.el.nickInput.getAttribute('aria-invalid')).toBe('true'); expect(document.activeElement).toBe(ui.el.nickInput);
});
it('requires a separate confirmation to close an empty nickname using the corner X', async () => {
  const result = ui.askNickname(2, ''); const done = vi.fn(); void result.then(done);
  expect(document.getElementById('btn-nick-skip')).toBeNull();
  button('btn-nick-close').click(); await Promise.resolve();
  expect(done).not.toHaveBeenCalled(); expect(document.getElementById('nick-dismiss')!.classList.contains('hidden')).toBe(false);
  expect(document.getElementById('nick-dismiss-message')!.textContent).toContain('匿名');
  expect(document.activeElement).toBe(button('btn-nick-edit'));
  button('btn-nick-edit').click(); expect(document.activeElement).toBe(ui.el.nickInput);
  button('btn-nick-close').click(); button('btn-nick-confirm-close').click();
  await expect(result).resolves.toBeNull(); expect(ui.el.modalNick.classList.contains('hidden')).toBe(true);
});
it('treats Escape as a request to close, then cancels that request on the second Escape', async () => {
  const done = vi.fn(); void ui.askNickname(2, '').then(done);
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(document.getElementById('nick-dismiss')!.classList.contains('hidden')).toBe(false);
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await Promise.resolve();
  expect(done).not.toHaveBeenCalled(); expect(document.getElementById('nick-dismiss')!.classList.contains('hidden')).toBe(true);
  expect(ui.el.modalNick.classList.contains('hidden')).toBe(false);
});
it('saves a valid nickname with Enter without intercepting IME confirmation', async () => {
  const result = ui.askNickname(2, ''); const done = vi.fn(); void result.then(done);
  ui.el.nickInput.value = '  玩家W  ';
  ui.el.nickInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }));
  await Promise.resolve(); expect(done).not.toHaveBeenCalled();
  ui.el.nickInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await expect(result).resolves.toBe('玩家W');
});
it('preserves a typed draft when cancelling close and still allows programmatic screen changes', async () => {
  const result = ui.askNickname(2, '玩家W');
  button('btn-nick-close').click(); expect(document.getElementById('nick-dismiss-message')!.textContent).toContain('尚未保存');
  button('btn-nick-edit').click(); expect(ui.nickValue).toBe('玩家W');
  ui.show('home'); await expect(result).resolves.toBeNull();
});
