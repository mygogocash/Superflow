import { useEffect, useState } from "react";
import { Platform, useWindowDimensions } from "react-native";

export { DESKTOP_MIN, TABLET_MIN } from "@/lib/breakpoints";

/** RN `useWindowDimensions` is often wrong on Expo web; prefer `window.innerWidth`. */
export function useViewportWidth() {
  const { width } = useWindowDimensions();
  const [webWidth, setWebWidth] = useState(() =>
    Platform.OS === "web" && typeof window !== "undefined" ? window.innerWidth : width,
  );

  useEffect(() => {
    if (Platform.OS !== "web") return;
    const sync = () => setWebWidth(window.innerWidth);
    sync();
    window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
  }, []);

  return Platform.OS === "web" ? webWidth : width;
}
