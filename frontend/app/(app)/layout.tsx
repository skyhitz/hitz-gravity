/**
 * Layout of the app pages: the home page (trade, vault, monitor), /sign,
 * /terminal and /ecosystem. A route group, so the URLs are unchanged.
 *
 * These are the pages that need an account: they get the wallet and protocol
 * providers, which restore a session, read the chain and poll it. The pages
 * outside the group (/whitepaper, /integrate, sign-in verification, 404) are
 * documents: they load none of that, make no background requests, and ship
 * only what it takes to show them.
 */

import { Providers } from "../components/Providers";

export default function AppLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <Providers>{children}</Providers>;
}
