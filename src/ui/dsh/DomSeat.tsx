import { useLayoutEffect, useRef } from 'react';
/** Boundary between the migrated DSH view and NPN's existing controllers. */
export function DomSeat({ node, className = '' }: { node: Element; className?: string }) {
  const seat = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { seat.current!.replaceChildren(node); }, [node]);
  return <div ref={seat} className={className} />;
}

