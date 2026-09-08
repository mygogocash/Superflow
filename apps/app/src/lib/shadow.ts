import { Platform } from "react-native";

/**
 * Tailwind's shadow-sm / shadow-md as web-only `boxShadow` style props.
 *
 * NativeWind's css-interop compiles `box-shadow` CSS to the deprecated RN
 * `shadowColor`/`shadowRadius` props, which react-native-web logs as a console
 * deprecation on every page. Inline `boxShadow` bypasses that pipeline; the
 * class-based shadows these replace rendered nothing on native (no
 * shadowOffset/shadowOpacity were ever set), so web-only keeps parity.
 */
/** CI §13 elevation — floating layers only (menus, dialogs), not cards. */
export const shadowSm = Platform.select({
  web: { boxShadow: "0 2px 8px rgba(11, 11, 10, 0.06)" },
});

export const shadowMd = Platform.select({
  web: { boxShadow: "0 8px 24px rgba(11, 11, 10, 0.08)" },
});
