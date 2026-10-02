/**
 * Office previews build DOM from document content (hyperlinks, embedded HTML chunks). Keep only safe
 * link targets and strip anything executable before the user can interact with it.
 */
export function sanitizeRendered(root: HTMLElement): void {
  root.querySelectorAll('script, iframe, object, embed').forEach(el => el.remove());
  root.querySelectorAll('*').forEach(el => {
    for (const attr of Array.from(el.attributes)) {
      if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
    }
  });
  root.querySelectorAll('a[href]').forEach(a => {
    const href = (a.getAttribute('href') ?? '').trim();
    if (/^(https?:|mailto:|#)/i.test(href)) {
      if (!href.startsWith('#')) { a.setAttribute('target', '_blank'); a.setAttribute('rel', 'noopener noreferrer'); }
    } else a.removeAttribute('href');
  });
}
