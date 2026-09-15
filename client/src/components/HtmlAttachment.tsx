import { useState } from 'react';

export function htmlPreviewUrl(url?: string) {
  const match = /^\/api\/notes\/([A-Za-z0-9_-]+)\/assets\/([A-Za-z0-9_-]+)$/.exec(url || '');
  return match ? `/api/html-previews/${match[1]}/${match[2]}` : null;
}

export function HtmlAttachment({ attachment }: { attachment: { url?: string; name?: string } }) {
  const [open, setOpen] = useState(false);
  const preview = htmlPreviewUrl(attachment.url);
  return <div className="chat-html-attachment" style={{ width: '100%' }}>
    {preview ? <a href={attachment.url} download={attachment.name} target="_blank" rel="noopener noreferrer">Download {attachment.name || 'HTML'}</a> : <span>Unavailable HTML attachment</span>}{' '}
    {preview && <button type="button" onClick={() => setOpen(!open)}>{open ? 'Close HTML preview' : 'Preview HTML'}</button>}
    {open && preview && <iframe title={attachment.name || 'HTML preview'} src={preview}
      sandbox="allow-scripts allow-forms" referrerPolicy="no-referrer"
      allow="camera 'none'; microphone 'none'; geolocation 'none'; display-capture 'none'"
      style={{ display: 'block', width: '100%', height: 520, border: '1px solid var(--border)', marginTop: 8 }} />}
  </div>;
}
