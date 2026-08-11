/**
 * @vitest-environment jsdom
 *
 * jsdom + React Testing Library component tests for the tile chrome the call
 * redesign renders on every video tile. These cover behavior the pure tests
 * can't reach — actual rendered DOM: the camera-off initial/photo fallback, the
 * image-error swap, the "(You)" self suffix, the mic-off icon, and the
 * connection-dot tooltip. The redesigned layout reuses these same components, so
 * locking their output guards a real regression surface.
 *
 * This file opts into jsdom via the docblock above; the rest of the suite stays
 * on the node env. See docs/plans/call-layout-redesign.md § test strategy.
 */
import { afterEach, describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

// tileChrome.jsx pulls in LiveKit at module load; stub it (same as the node
// tests) so the component imports without a real LiveKit runtime. lucide-react
// (the MicOff icon) renders a plain <svg> in jsdom and is left real.
vi.mock("@livekit/components-react", () => ({
  ParticipantTile: () => null,
  useIsSpeaking: () => false,
  useConnectionQualityIndicator: () => ({ quality: "excellent" }),
}));
vi.mock("livekit-client", () => ({
  Track: { Source: { Camera: "camera", ScreenShare: "screen_share", Microphone: "microphone" } },
  ConnectionQuality: { Excellent: "excellent", Good: "good", Poor: "poor", Unknown: "unknown" },
}));

import { CameraOffAvatar, TileNamePill } from "./tileChrome";

// RTL auto-cleanup only registers when Vitest globals are on; they're off here,
// so unmount between tests ourselves to keep the jsdom document clean.
afterEach(cleanup);

const A_PIXEL =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

describe("CameraOffAvatar", () => {
  it("shows a single uppercase initial when there is no photo", () => {
    render(<CameraOffAvatar participant={{ identity: "u1", name: "Ada Lovelace" }} avatarSrc={null} />);
    expect(screen.getByText("A")).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("prefers the explicit dispName over the participant name for the initial", () => {
    render(
      <CameraOffAvatar
        participant={{ identity: "u1", name: "Ada Lovelace" }}
        avatarSrc={null}
        dispName="Grace Hopper"
      />,
    );
    expect(screen.getByText("G")).toBeTruthy();
    expect(screen.queryByText("A")).toBeNull();
  });

  it('falls back to "G" (Guest) when there is no name at all', () => {
    render(<CameraOffAvatar participant={{}} avatarSrc={null} />);
    expect(screen.getByText("G")).toBeTruthy();
  });

  it("renders the profile photo when a src is given, hiding the initial", () => {
    // The <img> is decorative (alt=""), so it has no ARIA "img" role — query the
    // element directly rather than by role.
    const { container } = render(
      <CameraOffAvatar participant={{ identity: "u1", name: "Ada Lovelace" }} avatarSrc={A_PIXEL} />,
    );
    const img = container.querySelector("img");
    expect(img).toBeTruthy();
    expect(img.getAttribute("src")).toBe(A_PIXEL);
    expect(screen.queryByText("A")).toBeNull();
  });

  it("swaps back to the initial if the photo fails to load", () => {
    const { container } = render(
      <CameraOffAvatar participant={{ identity: "u1", name: "Ada Lovelace" }} avatarSrc={A_PIXEL} />,
    );
    fireEvent.error(container.querySelector("img"));
    expect(screen.getByText("A")).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
  });
});

describe("TileNamePill", () => {
  it("shows the display name and no self suffix for a remote tile", () => {
    render(<TileNamePill dispName="Ada" isLocal={false} />);
    expect(screen.getByText("Ada")).toBeTruthy();
    expect(screen.queryByText(/\(You\)/)).toBeNull();
  });

  it('appends " (You)" for the local participant', () => {
    const { container } = render(<TileNamePill dispName="Ada" isLocal />);
    expect(container.textContent).toContain("Ada (You)");
  });

  it("renders a mic-off icon only when the mic is muted", () => {
    const { container: off } = render(<TileNamePill dispName="Ada" micOff />);
    expect(off.querySelector("svg")).toBeTruthy(); // MicOff icon present
    cleanup();
    const { container: on } = render(<TileNamePill dispName="Ada" micOff={false} />);
    expect(on.querySelector("svg")).toBeNull();
  });

  it("shows a weak-connection dot and escalates its tooltip when the link is lost", () => {
    const { container: weak } = render(<TileNamePill dispName="Ada" weak lost={false} />);
    expect(weak.querySelector('[title="Weak connection"]')).toBeTruthy();
    cleanup();
    const { container: lost } = render(<TileNamePill dispName="Ada" weak lost />);
    expect(lost.querySelector('[title="Connection lost"]')).toBeTruthy();
    cleanup();
    const { container: ok } = render(<TileNamePill dispName="Ada" weak={false} />);
    expect(ok.querySelector("[title]")).toBeNull();
  });
});
