import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import AgeGate from "@/components/AgeGate";
import { getCurrentUser } from "@/lib/session";
import { isStaff } from "@/lib/permissions";
import { logoutAction } from "@/app/actions/auth";
import { getPaymentProvider } from "@/lib/payments";
import { DevBanner } from "@/components/ui";

export const metadata: Metadata = {
  title: "Brooke's Closet",
  description: "A creator-owned membership community for adults.",
  robots: { index: true, follow: true },
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  const sim = getPaymentProvider().isSimulation;
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <AgeGate />
        <header className="border-b border-line">
          <nav className="mx-auto flex max-w-6xl flex-wrap items-center gap-5 px-5 py-4 text-sm">
            <Link href="/" className="font-display text-xl text-rose">Brooke&apos;s Closet</Link>
            <Link href="/creators" className="text-mute hover:text-cream">Creators</Link>
            <Link href="/browse" className="text-mute hover:text-cream">Browse</Link>
            <Link href="/packages" className="text-mute hover:text-cream">Packages</Link>
            <Link href="/plans" className="text-mute hover:text-cream">Membership</Link>
            <Link href="/live" className="text-mute hover:text-cream">Live</Link>
            <span className="flex-1" />
            {user ? (
              <>
                {isStaff(user.role, user.status) && <Link href="/admin" className="text-amber-300 hover:text-amber-100">Admin</Link>}
                <Link href="/dashboard" className="hover:text-rose">Dashboard</Link>
                <Link href="/settings" className="hover:text-rose">Settings</Link>
                <form action={logoutAction}><button className="text-mute hover:text-cream">Log out</button></form>
              </>
            ) : (
              <>
                <Link href="/login" className="hover:text-rose">Log in</Link>
                <Link href="/register" className="btn btn-primary btn-sm">Join free</Link>
              </>
            )}
          </nav>
        </header>
        <main className="mx-auto max-w-6xl px-5 py-8">
          {sim && <DevBanner><b>Development mode:</b> checkout is a simulation and cannot charge real money. No real payment provider is connected.</DevBanner>}
          {children}
        </main>
        <footer className="mt-16 border-t border-line py-8 text-center text-xs text-mute">
          <p>18+ only. All featured creators are verified adults who have consented to publication.</p>
          <p className="mt-2 space-x-4">
            <Link href="/legal/terms">Terms</Link><Link href="/legal/privacy">Privacy</Link>
            <Link href="/report">Report content / takedown request</Link>
          </p>
        </footer>
      </body>
    </html>
  );
}
