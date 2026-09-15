import DOMPurify from 'dompurify';
import { useEffect, useState } from 'react';

let nextDiagramId = 0;
const rendered = new Map<string, Promise<string>>();
const mermaidRenderer = import('mermaid').then(({ default: mermaid }) => {
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    htmlLabels: false,
  });
  return mermaid;
});

function sanitizeMermaidSvg(svg: string): string {
  return DOMPurify
    .sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } })
    .replace(/\s(?:href|xlink:href|src)=["']https?:\/\/[^"']*["']/gi, '');
}
async function renderMermaid(source: string): Promise<string> {
  let pending = rendered.get(source);
  if (!pending) {
    pending = mermaidRenderer.then(async (mermaid) => {
      const id = `fizzer-mermaid-${++nextDiagramId}`;
      const { svg } = await mermaid.render(id, source);
      return sanitizeMermaidSvg(svg);
    });
    rendered.set(source, pending);
    pending.catch(() => rendered.delete(source));
    if (rendered.size > 100) rendered.delete(rendered.keys().next().value!);
  }
  return pending;
}

export function MermaidDiagram({ source }: { source: string }) {
  const [state, setState] = useState<{ source: string; svg?: string; failed?: boolean }>(() => ({ source }));

  useEffect(() => {
    let active = true;
    void renderMermaid(source).then(
      (svg) => { if (active) setState({ source, svg }); },
      () => { if (active) setState({ source, failed: true }); },
    );
    return () => { active = false; };
  }, [source]);

  if (state.source !== source || (!state.svg && !state.failed)) {
    return <span className="chat-mermaid is-loading" role="status">Rendering diagram…</span>;
  }
  if (state.failed) {
    return <code className="language-mermaid">{source}</code>;
  }
  return <span className="chat-svg chat-mermaid" aria-label="Mermaid diagram" dangerouslySetInnerHTML={{ __html: state.svg! }} />;
}
