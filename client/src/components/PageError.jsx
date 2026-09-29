import { useNavigate, useRouteError } from 'react-router-dom';
import { EmptyState } from './Bits';
import { primaryBtn, ghostBtn } from './DetailHero';

/**
 * What a page shows when it fails to draw. Without this the router replaced
 * the whole window, sidebar included, with a stack trace; now the rest of the
 * app keeps working and moving to another page clears it.
 */
export default function PageError() {
  const error = useRouteError();
  const navigate = useNavigate();
  const message = error?.message || String(error || 'Unknown error');
  return (
    <EmptyState
      icon="⚠"
      title="This page couldn’t be shown"
      hint={`Something went wrong drawing it: ${message}. The rest of Shelf still works.`}
      action={
        <div className="mt-2 flex gap-2">
          <button className={primaryBtn} onClick={() => window.location.reload()}>
            Reload
          </button>
          <button className={ghostBtn} onClick={() => navigate('/')}>
            Go to library
          </button>
        </div>
      }
    />
  );
}
