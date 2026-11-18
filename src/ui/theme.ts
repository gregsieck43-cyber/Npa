import { append, button, element, icon } from './dom.js';

export type Theme = 'light' | 'dark';
const storageKey = 'npn-gamma-theme';

export function initializeTheme(): void {
  applyTheme(localStorage.getItem(storageKey) === 'dark' ? 'dark' : 'light');
}

export function currentTheme(): Theme { return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'; }

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  document.body.toggleAttribute('data-ds-dark-theme', theme === 'dark');
  localStorage.setItem(storageKey, theme);
  document.querySelectorAll<HTMLButtonElement>('[data-theme-choice]').forEach(node => {
    const selected = node.dataset.themeChoice === theme;
    node.classList.toggle('selected', selected); node.setAttribute('aria-pressed', String(selected));
  });
  document.querySelectorAll<HTMLButtonElement>('[data-testid="toggle-theme"]').forEach(node => {
    node.replaceChildren(icon(theme === 'light' ? 'moon' : 'sun'));
    node.title = theme === 'light' ? '切换深色主题' : '切换暖白主题'; node.setAttribute('aria-label', node.title);
  });
}

export function themeToggle(): HTMLButtonElement {
  const node = button('', () => applyTheme(currentTheme() === 'light' ? 'dark' : 'light'), 'icon-button ghost', 'toggle-theme');
  node.append(icon(currentTheme() === 'light' ? 'moon' : 'sun'));
  node.title = currentTheme() === 'light' ? '切换深色主题' : '切换暖白主题'; node.setAttribute('aria-label', node.title);
  return node;
}

export function themePicker(): HTMLElement {
  const choices = element('div', 'theme-choices');
  for (const [theme, title, caption] of [['light', '暖白', '柔和纸色，专注阅读'], ['dark', '深色', '低亮画布，适合夜间']] as const) {
    const node = button('', () => applyTheme(theme), `theme-choice${currentTheme() === theme ? ' selected' : ''}`, `theme-${theme}`);
    node.dataset.themeChoice = theme; node.setAttribute('aria-pressed', String(currentTheme() === theme));
    const preview = element('span', `theme-preview ${theme}`);
    preview.append(element('i', 'preview-sidebar'), append(element('span', 'preview-content'), element('i'), element('i'), element('i', 'preview-input')));
    node.append(preview, append(element('span', 'theme-caption'), element('strong', '', title), element('span', '', caption), icon('check')));
    choices.append(node);
  }
  return choices;
}
