// Present-only mode flag; controlled via query param for quick toggling.
export const PRESENT_ONLY =
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).get("mode") === "present";

