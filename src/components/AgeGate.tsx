"use client";
import { useEffect, useState } from "react";

/**
 * Adult-content notice. This is an informational/legal courtesy gate, NOT age verification and NOT a
 * security control. Restricted content is protected by server-side authorization.
 */
export default function AgeGate() {
  const [show, setShow] = useState(false);
  useEffect(() => { setShow(localStorage.getItem("bc_age_ok") !== "1"); }, []);
  if (!show) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/95 p-6" role="dialog" aria-modal="true" aria-labelledby="age-title">
      <div className="max-w-md rounded-2xl border border-line bg-panel p-8 text-center">
        <h2 id="age-title" className="font-display text-2xl">Adults only (18+)</h2>
        <p className="mt-3 text-sm text-mute">
          Brooke&apos;s Closet contains adult material. By entering you confirm you are at least 18 years old
          (or the age of majority where you live) and that viewing adult material is legal where you are.
        </p>
        <div className="mt-6 flex justify-center gap-3">
          <button className="btn btn-primary" onClick={() => { localStorage.setItem("bc_age_ok", "1"); setShow(false); }}>I am 18 or older — enter</button>
          <a className="btn" href="https://www.google.com">Leave</a>
        </div>
      </div>
    </div>
  );
}
