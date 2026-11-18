import { append, button, element, icon, input } from './dom.js';

export interface PaletteCommand { id: string; label: string; detail: string; group: string; glyph: string; keywords?: string; shortcut?: string; run(): void; }

export function filterCommands(commands: PaletteCommand[], query: string): PaletteCommand[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return commands.filter(command => terms.every(term => `${command.label} ${command.detail} ${command.keywords ?? ''}`.toLocaleLowerCase().includes(term)));
}

export function openCommandPalette(getCommands: () => PaletteCommand[]): void {
  if (document.querySelector('.modal-overlay,dialog[open]')) return;
  const previous = document.activeElement as HTMLElement | null;
  const overlay = element('div', 'modal-overlay command-overlay'), dialog = element('section', 'command-palette');
  dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); dialog.setAttribute('aria-label', '搜索会话与操作');
  const close = () => { overlay.remove(); previous?.focus(); };
  const search = input('', '搜索会话、项目或操作…', 'command-search'); search.setAttribute('aria-label', '搜索会话与操作'); search.setAttribute('role', 'combobox'); search.setAttribute('aria-expanded', 'true'); search.setAttribute('aria-controls', 'command-options'); search.setAttribute('aria-autocomplete', 'list');
  const dismiss = button('Esc', close, 'small ghost', 'close-command-palette');
  const results = element('div', 'command-results'); results.id = 'command-options'; results.setAttribute('role', 'listbox');
  let commands = getCommands(), filtered = commands, selected = 0;
  const activate = (index: number, scroll = true) => {
    selected = index;
    [...results.querySelectorAll<HTMLElement>('[role=option]')].forEach((node, position) => { node.classList.toggle('selected', position === selected); node.setAttribute('aria-selected', String(position === selected)); });
    const active = results.querySelector<HTMLElement>('.selected');
    if (active) { search.setAttribute('aria-activedescendant', active.id); if (scroll) active.scrollIntoView({ block: 'nearest' }); }
    else search.removeAttribute('aria-activedescendant');
  };
  const execute = (command: PaletteCommand) => { close(); command.run(); };
  const paint = () => {
    filtered = filterCommands(commands, search.value); selected = 0; results.replaceChildren(); let group = '';
    if (!filtered.length) results.append(element('p', 'empty-small', '没有匹配的会话或操作'));
    filtered.forEach((command, index) => {
      if (command.group !== group) { results.append(element('div', 'command-group', command.group)); group = command.group; }
      const item = button('', () => execute(command), 'command-item', `command-${command.id}`); item.id = `command-option-${index}`; item.tabIndex = -1; item.setAttribute('role', 'option');
      item.append(icon(command.glyph), append(element('span', 'grow'), element('strong', '', command.label), element('span', 'command-detail', command.detail)), element('kbd', '', command.shortcut ?? '↵'));
      item.addEventListener('pointermove', () => activate(index, false)); results.append(item);
    });
    activate(0);
  };
  search.addEventListener('input', paint);
  dialog.addEventListener('keydown', event => {
    if (event.isComposing) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); if (filtered.length) activate((selected + (event.key === 'ArrowDown' ? 1 : filtered.length - 1)) % filtered.length); }
    else if (event.key === 'Enter' && event.target === search) { event.preventDefault(); if (filtered[selected]) execute(filtered[selected]); }
    else if (event.key === 'Tab') { event.preventDefault(); (document.activeElement === search ? dismiss : search).focus(); }
  });
  overlay.addEventListener('click', event => { if (event.target === overlay) close(); });
  dialog.append(append(element('div', 'command-search-row'), icon('search'), search, dismiss), results, append(element('footer', 'command-footer'), element('span', '', '↑ ↓ 选择'), element('span', '', 'Enter 打开'), element('span', '', 'Ctrl K 快速访问')));
  overlay.append(dialog); document.body.append(overlay); paint(); search.focus();
}
