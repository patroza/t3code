import { useState, useEffect } from "react";

export function useModifierRevealHeld(enabled: boolean): boolean {
  const [held, setHeld] = useState(false);

  if (!enabled && held) setHeld(false);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to global modifier-key and blur events while shortcut reveal is enabled
  useEffect(() => {
    if (!enabled) return;

    const onKey = (event: KeyboardEvent) => setHeld(event.metaKey || event.ctrlKey);
    const onBlur = () => setHeld(false);

    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKey, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKey, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [enabled]);

  return enabled && held;
}
