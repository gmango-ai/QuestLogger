import { useParams, Link } from "react-router-dom";
import { WhiteboardBoard } from "./WhiteboardPage";
import { AppContext } from "../context/AppContext";
import { TeamContext } from "../context/TeamContext";

// Public, read-only whiteboard viewer at /w/:id. Renders OUTSIDE the app's auth
// gate (see the top-level route in App.jsx), so anyone with the link — including
// signed-out visitors — can view a board whose scope is 'public'. RLS returns
// the row ONLY when it's public + not archived, and grants no write path, so a
// non-public id simply shows the board's own "not found" state and edits are
// impossible. Read-only also disables the realtime channel (no broadcast ops).

// Minimal stand-in context values so the editor's useApp()/useTeam() don't crash
// without the AuthenticatedApp provider stack. No per-user queries run.
const PUBLIC_APP = { session: null, settings: {} };
const PUBLIC_TEAM = { isAdmin: false, activeTeamId: null };

export default function PublicWhiteboardPage() {
  const { whiteboardId } = useParams();
  return (
    <AppContext.Provider value={PUBLIC_APP}>
      <TeamContext.Provider value={PUBLIC_TEAM}>
        <div
          className="fixed inset-0 bg-white dark:bg-[var(--color-surface)]"
          style={{ "--nav-h": "0px", "--top-inset": "0px", "--bottom-inset": "0px" }}
        >
          <WhiteboardBoard boardId={whiteboardId} readOnly />
          <div className="fixed top-2 left-2 z-[300] inline-flex items-center gap-2 text-[11px] px-2.5 py-1 rounded-full bg-black/60 text-white/90 backdrop-blur">
            <span>Read-only · shared whiteboard</span>
            <Link to="/login" className="underline hover:text-white">Sign in</Link>
          </div>
        </div>
      </TeamContext.Provider>
    </AppContext.Provider>
  );
}
