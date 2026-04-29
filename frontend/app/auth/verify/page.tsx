"use client";

/**
 * /auth/verify — landing page for the magic-link URL.
 *
 * The link the user clicked looks like `/auth/verify/?token=...`. On mount
 * we:
 *   1. Read the token from the URL.
 *   2. POST it to /api/auth/verify — the Worker single-consumes it and
 *      sets the session cookie on the response.
 *   3. Redirect to "/" (home) where the session is now live.
 *
 * Three visible states: verifying (spinner), error (retry link), success
 * (briefly flashes before the redirect). We don't show the address during
 * the flash — the user shouldn't need to care, just land home already
 * signed in.
 *
 * Static-export note: Next.js compiles this to a plain static HTML page
 * because it's a "use client" leaf route with no data-fetching at render.
 * The token read + fetch all happen in the browser.
 */

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { verify } from "../../lib/gateway";

interface RedeemedDisplay {
  amount: string;
  txHash: string;
  xlmAmount?: string;
  xlmTxHash?: string;
}

type State =
  | { kind: "verifying" }
  | { kind: "success"; redeemed: RedeemedDisplay | null }
  | { kind: "error"; message: string };

export default function VerifyPage() {
  const [state, setState] = useState<State>({ kind: "verifying" });

  // The token is read directly from the URL + POSTed — an external-system
  // sync, not state-derivation. Guarded by a ref so StrictMode's double-
  // invoke doesn't burn the single-use token on the second render.
  const firedRef = useRef(false);
  useEffect(() => {
    if (firedRef.current) return;
    firedRef.current = true;

    const params = new URLSearchParams(window.location.search);
    const token = params.get("token");
    if (!token) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- external-system sync result
      setState({ kind: "error", message: "Missing sign-in token." });
      return;
    }

    verify(token).then((res) => {
      if (!res.ok) {
        setState({ kind: "error", message: res.error });
        return;
      }
      const redeemed = res.data.redeemed;
      setState({ kind: "success", redeemed });
      // Linger on the claim confirmation so the user actually reads it.
      // Plain sign-in redirects fast; reparation redemptions get a longer
      // pause to show the amount + checkmark.
      setTimeout(
        () => {
          window.location.replace("/");
        },
        redeemed ? 2200 : 600
      );
    });
  }, []);

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
    >
      <div
        className="fade-in"
        style={{
          width: "100%",
          maxWidth: 420,
          padding: "32px 28px",
          borderRadius: 20,
          border: "1px solid var(--border)",
          background: "var(--card)",
          textAlign: "center",
        }}
      >
        <div
          style={{
            letterSpacing: ".18em",
            textTransform: "uppercase",
            fontSize: 11,
            color: "var(--muted)",
            marginBottom: 12,
          }}
        >
          HITZ · Sign-in
        </div>

        {state.kind === "verifying" && (
          <>
            <div
              style={{
                width: 40,
                height: 40,
                borderRadius: "50%",
                border: "3px solid var(--border)",
                borderTopColor: "var(--accent)",
                animation: "slow-spin 0.9s linear infinite",
                margin: "12px auto 18px",
              }}
            />
            <p style={{ margin: 0, color: "var(--muted)", fontSize: 14 }}>
              Verifying your sign-in link…
            </p>
          </>
        )}

        {state.kind === "success" && (
          <>
            <div
              style={{
                width: 56,
                height: 56,
                borderRadius: 16,
                background: "rgba(48,209,88,.12)",
                border: "1px solid rgba(48,209,88,.3)",
                color: "var(--green)",
                fontSize: 28,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                margin: "8px auto 18px",
              }}
            >
              ✓
            </div>
            {state.redeemed ? (
              <>
                <h2 style={{ margin: "0 0 6px", fontSize: 18 }}>
                  You claimed{" "}
                  <span style={{ color: "var(--green)" }}>
                    {state.redeemed.amount} HITZ
                  </span>
                  {state.redeemed.xlmAmount ? (
                    <>
                      {" + "}
                      <span style={{ color: "var(--green)" }}>
                        {state.redeemed.xlmAmount} XLM
                      </span>
                    </>
                  ) : null}
                  .
                </h2>
                <p style={{ margin: "0 0 4px", color: "var(--muted)", fontSize: 13 }}>
                  Welcome back to SKYHITZ.
                </p>
                <p style={{ margin: 0, color: "var(--muted)", fontSize: 12 }}>
                  Redirecting you to HITZ…
                </p>
              </>
            ) : (
              <>
                <h2 style={{ margin: "0 0 6px", fontSize: 18 }}>You&apos;re signed in.</h2>
                <p style={{ margin: 0, color: "var(--muted)", fontSize: 13 }}>
                  Redirecting you to HITZ…
                </p>
              </>
            )}
          </>
        )}

        {state.kind === "error" && (
          <>
            <div
              style={{
                width: 56,
                height: 56,
                borderRadius: 16,
                background: "rgba(255,69,58,.1)",
                border: "1px solid rgba(255,69,58,.3)",
                color: "var(--red)",
                fontSize: 26,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                margin: "8px auto 18px",
              }}
            >
              !
            </div>
            <h2 style={{ margin: "0 0 6px", fontSize: 18 }}>Sign-in failed</h2>
            <p style={{ margin: "0 0 18px", color: "var(--muted)", fontSize: 13 }}>
              {state.message || "This link may have expired or already been used."}
            </p>
            <Link
              href="/"
              style={{
                display: "inline-block",
                padding: "10px 18px",
                borderRadius: 10,
                background: "var(--accent)",
                color: "#fff",
                fontSize: 13,
                fontWeight: 600,
                textDecoration: "none",
              }}
            >
              Back to HITZ →
            </Link>
          </>
        )}
      </div>
    </div>
  );
}
