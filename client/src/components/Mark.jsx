/**
 * The Shelf mark: four cases standing on a shelf, one of them a film case.
 * The same drawing as build/icon.png, so the app and its icon agree.
 *
 * Draws in `currentColor`; the sprocket holes take the tile colour behind them.
 */
export default function Mark({ className = '', holes = 'fill-accent' }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" fill="currentColor">
      {/* cases, standing on the shelf line at y=17 */}
      <rect x="4.3" y="9.9" width="2.7" height="7.1" rx="0.5" />
      <rect x="7.9" y="7.9" width="3.4" height="9.1" rx="0.5" />
      <rect x="12.2" y="9.1" width="2.7" height="7.9" rx="0.5" />
      <rect x="15.9" y="8.8" width="2.7" height="8.2" rx="0.5" transform="rotate(9 18.6 17)" />
      {/* sprocket holes, which is what makes one of them a film */}
      <g className={holes}>
        <rect x="9" y="9.2" width="1.2" height="0.9" rx="0.25" />
        <rect x="9" y="10.9" width="1.2" height="0.9" rx="0.25" />
        <rect x="9" y="12.6" width="1.2" height="0.9" rx="0.25" />
        <rect x="9" y="14.3" width="1.2" height="0.9" rx="0.25" />
      </g>
      {/* the shelf */}
      <rect x="3" y="17" width="18" height="2" rx="0.6" />
    </svg>
  );
}
