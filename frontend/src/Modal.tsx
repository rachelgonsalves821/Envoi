import { useEffect, useId, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';

export function Modal({ title, children, onClose, dismissible = true, className = '' }: {
  title: string; children: ReactNode; onClose: () => void; dismissible?: boolean; className?: string;
}) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const closeOptions = useRef({ onClose, dismissible });
  closeOptions.current = { onClose, dismissible };

  useEffect(() => {
    panel.current?.focus();
    function handleKey(event: KeyboardEvent) {
      if (event.key === 'Escape' && closeOptions.current.dismissible) closeOptions.current.onClose();
      if (event.key !== 'Tab' || !panel.current) return;
      const focusable = [...panel.current.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])')]
        .filter(item => item.getClientRects().length);
      if (!focusable.length) {
        event.preventDefault();
        panel.current.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, []);

  return <div className="modal-layer">
    <button className="modal-scrim" aria-label={dismissible ? 'Close dialog' : undefined} onClick={dismissible ? onClose : undefined} />
    <div className={className ? `modal ${className}` : 'modal'} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} ref={panel}>
      <header>
        <h2 id={titleId}>{title}</h2>
        {dismissible && <button className="icon-button" aria-label="Close dialog" onClick={onClose}><X size={18} /></button>}
      </header>
      {children}
    </div>
  </div>;
}
