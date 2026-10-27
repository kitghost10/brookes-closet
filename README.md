# Brooke's Closet — 18+ Adult Creator Platform

A creator-owned luxury adult membership community featuring uncensored photo sets, explicit 4K cinema videos, interactive livestreams, duo performer collaborations, and standalone vault drops.

---

## 🌐 Live Interactive Preview Links

* **Live Hosted Website (GitHub Pages)**: **[https://kitghost10.github.io/brookes-closet/](https://kitghost10.github.io/brookes-closet/)**
* **GitHub Repository**: **[https://github.com/kitghost10/brookes-closet](https://github.com/kitghost10/brookes-closet)**

---

## 🚀 Interactive Client Preview (Local)

The project currently features a fully interactive, high-fidelity **Client Preview** to showcase the UX, monetization model, access control, and visual aesthetics before deploying full backend infrastructure.

### How to Access the Preview

1. **Local Preview Server**:
   ```bash
   npm run preview
   ```
   Open **`http://localhost:3000`** in any web browser.

2. **Direct File Access**:
   Open `preview.html` directly in your browser.

---

## 🔞 Key Features Implemented in the Preview

* **Interactive Persona Switcher (Top Bar)**:
  * 👤 **Guest (Logged Out)**: Views censored previews with paywall blocks on explicit media.
  * 🎟️ **Free Member**: Logged-in experience with SFW teasers and PPV purchase capabilities.
  * 👑 **VIP Uncensored ($19.99/mo)**: Full nude vault unlocked, interactive live shows with chat, renewal date, and billing controls.
  * 🛡️ **Admin / Owner (Brooke)**: Access to the **Admin Studio**, 2257 performer verification queue, content library manager, and operational revenue metrics.

* **18+ Age Verification & Legal Compliance**:
  * Realistic adult confirmation gate with **18 U.S.C. § 2257 Record-Keeping Requirements Compliance Notice**.
  * Custodian of records and government ID verification badges for all featured performers.

* **The Uncensored Vault & Access Control**:
  * Filtering for Full Nude Photosets, 4K Solo Videos, Duo Collabs, Standalone PPV Drops, and SFW Teasers.
  * Server-side access check simulation: authorized users receive simulated short-lived signed tokens with anti-leak watermarking; unauthorized users receive paywall modals.

* **Adult Memberships & PPV Store**:
  * **Free Account**: $0/mo.
  * **VIP Uncensored**: $19.99/mo recurring.
  * **All-Access Allure**: $39.99/mo recurring (includes all paid PPV drops).
  * **Standalone PPV Vault Drops**: $14.99 and $24.99 lifetime unlocks.
  * **Development Checkout Simulation**: Simulates high-risk adult payment gateways (CCBill / Segpay) with instant real-time unlocking.

* **Live Erotic Broadcast Studio**:
  * HLS video player interface with live viewer counter.
  * Access check for subscriber-only broadcasts.
  * Simulated interactive live chat.
  * **Live Tip Goals & Toy Vibration Menu** ($10 Vibe 15s, $25 High Vibe, $50 Oil Massage, $100 Custom Climax).

* **Performer Roster (2257 Verified)**:
  * Brooke Sterling (Lead Creator & Owner)
  * Chloe V. (Guest Performer)
  * Elena Noir (Fetish Artist)

---

## 🛠️ Production Roadmap (When Client Approves Backend)

When the client is ready to proceed with production backend development:
1. **Database**: PostgreSQL / Supabase with Prisma migrations for users, subscriptions, purchases, 2257 records, and audit logs.
2. **Private Storage**: S3-compatible private object store (e.g. AWS S3, Cloudflare R2, Telnyx Storage) with short-lived pre-signed URLs.
3. **High-Risk Payment Processor**: Integration of CCBill, Segpay, or Epoch webhook handlers for automated subscription management.
4. **Streaming Provider**: Integration of Livepeer, Cloudflare Stream, or Mux with Lovense Bluetooth toy socket integration.
