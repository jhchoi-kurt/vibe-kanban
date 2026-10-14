import { useEffect, useState, useRef } from 'react';
import { createPortal } from 'react-dom';

interface MermaidDiagramProps {
  chart: string;
  theme: 'light' | 'dark';
}

// Serialize all mermaid operations to avoid concurrent render/initialize races
let mermaidQueue: Promise<void> = Promise.resolve();
let initializedTheme: string | null = null;

export function MermaidDiagram({ chart, theme }: MermaidDiagramProps) {
  const [svg, setSvg] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const renderCountRef = useRef(0);
  const [zoomOpen, setZoomOpen] = useState(false);
  const [scale, setScale] = useState(1.5);

  useEffect(() => {
    if (!zoomOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setZoomOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zoomOpen]);

  useEffect(() => {
    let cancelled = false;
    const renderId = ++renderCountRef.current;

    mermaidQueue = mermaidQueue.then(async () => {
      if (cancelled) return;

      try {
        const { default: mermaid } = await import('mermaid');
        const mermaidTheme = theme === 'dark' ? 'dark' : 'default';

        if (initializedTheme !== mermaidTheme) {
          mermaid.initialize({
            startOnLoad: false,
            theme: mermaidTheme,
            securityLevel: 'strict',
          });
          initializedTheme = mermaidTheme;
        }

        // Use renderId to ensure each render call gets a unique DOM element ID
        const { svg: renderedSvg } = await mermaid.render(
          `mermaid-${renderId}-${Date.now()}`,
          chart
        );

        if (!cancelled) {
          setSvg(renderedSvg);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : 'Failed to render diagram'
          );
          setSvg('');
        }
      }
    });

    return () => {
      cancelled = true;
    };
  }, [chart, theme]);

  if (error) {
    return (
      <div className="rounded-sm border border-error/20 bg-error/5 p-base">
        <p className="text-xs text-error mb-2">Mermaid diagram error</p>
        <pre className="text-xs text-low overflow-auto">
          <code>{chart}</code>
        </pre>
      </div>
    );
  }

  if (!svg) {
    return (
      <div className="flex items-center justify-center p-base text-low text-sm">
        Loading diagram…
      </div>
    );
  }

  const btn =
    'rounded-sm border border-border bg-secondary px-base py-half text-sm text-normal hover:bg-panel';
  return (
    <>
      <div className="group relative my-3">
        <div
          className="flex cursor-zoom-in justify-center overflow-auto [&_svg]:h-auto [&_svg]:w-full [&_svg]:!max-w-full"
          title="클릭하면 크게 볼 수 있어요"
          onClick={() => setZoomOpen(true)}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
        <button
          type="button"
          className="absolute right-1 top-1 rounded-sm bg-secondary/90 px-half py-[1px] text-xs text-low opacity-70 hover:opacity-100 group-hover:opacity-100"
          onClick={() => setZoomOpen(true)}
        >
          ⤢ 크게 보기
        </button>
      </div>
      {zoomOpen &&
        createPortal(
          <div
            className="fixed inset-0 z-[1000] flex flex-col bg-black/70 backdrop-blur-sm"
            onClick={() => setZoomOpen(false)}
          >
            <div
              className="flex items-center justify-end gap-half p-base"
              onClick={(e) => e.stopPropagation()}
            >
              <button
                type="button"
                className={btn}
                onClick={() => setScale((v) => Math.max(0.5, v - 0.25))}
              >
                −
              </button>
              <span className="w-14 text-center text-sm text-white">
                {Math.round(scale * 100)}%
              </span>
              <button
                type="button"
                className={btn}
                onClick={() => setScale((v) => Math.min(6, v + 0.25))}
              >
                +
              </button>
              <button type="button" className={btn} onClick={() => setScale(1)}>
                화면에 맞춤
              </button>
              <button
                type="button"
                className={btn}
                onClick={() => setZoomOpen(false)}
              >
                닫기 (Esc)
              </button>
            </div>
            <div
              className="flex-1 overflow-auto p-base"
              onClick={(e) => e.stopPropagation()}
              onWheel={(e) => {
                if (e.ctrlKey || e.metaKey) {
                  e.preventDefault();
                  setScale((v) =>
                    Math.min(6, Math.max(0.5, v - e.deltaY * 0.002))
                  );
                }
              }}
            >
              <div
                className="mx-auto rounded-sm bg-primary p-base [&_svg]:h-auto [&_svg]:w-full [&_svg]:!max-w-none"
                style={{ width: `${scale * 100}%` }}
                dangerouslySetInnerHTML={{ __html: svg }}
              />
            </div>
          </div>,
          document.body
        )}
    </>
  );
}
