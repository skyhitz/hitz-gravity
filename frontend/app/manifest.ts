/**
 * /manifest.webmanifest: how the app is named and coloured when someone adds
 * it to a home screen, and what a browser shows while it loads.
 */

import type { MetadataRoute } from "next";
import { HOME_DESCRIPTION, PROTOCOL_NAME } from "./lib/site";

export const dynamic = "force-static";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: PROTOCOL_NAME,
    short_name: "HITZ",
    description: HOME_DESCRIPTION,
    id: "/",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#0a0a0a",
    theme_color: "#0a0a0a",
    categories: ["finance"],
    icons: [
      { src: "/icon-128.png", sizes: "128x128", type: "image/png" },
      { src: "/icon.png", sizes: "180x180", type: "image/png" },
    ],
  };
}
