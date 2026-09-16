import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { HtmlAttachment, htmlPreviewUrl } from '../components/HtmlAttachment';

describe('HTML attachments', () => {
  it('derives only the authenticated exact local asset preview route', () => {
    expect(htmlPreviewUrl('/api/notes/channel-1/assets/asset_2')).toBe('/api/html-previews/channel-1/asset_2');
  });
  for (const url of ['https://evil.invalid/demo.html', 'javascript:alert(1)', '/api/notes/../assets/x', '/api/notes/a/assets/b?redirect=x', '//evil.invalid']) {
    it(`refuses an untrusted attachment URL: ${url}`, () => {
      expect(htmlPreviewUrl(url)).toBeNull();
      expect(renderToStaticMarkup(createElement(HtmlAttachment, { attachment: { url } }))).not.toContain('href=');
    });
  }
  it('does not execute or load a preview until explicitly opened', () => {
    const html = renderToStaticMarkup(createElement(HtmlAttachment, { attachment: { url: '/api/notes/a/assets/b', name: '<script>demo</script>' } }));
    expect(html).toContain('Preview HTML');
    expect(html).toContain('download=');
    expect(html).not.toContain('<iframe');
    expect(html).not.toContain('<script>');
  });
});
