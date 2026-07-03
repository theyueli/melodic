// Lazy-loaded HTML→Markdown converter — injected on the first rich paste.
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

window.__turndown = () => {
  const svc = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '*',
    hr: '---'
  });
  svc.use(gfm);
  svc.keep(['u', 'kbd', 'sub', 'sup']);
  return svc;
};
