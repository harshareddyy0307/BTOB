# TradeBridge B2B — Manufacturer Catalog & Business Operations Platform

TradeBridge B2B is a full-stack wholesale distribution and operations management web application built with React, TypeScript, Vite, Tailwind CSS, and Supabase. It provides a protected operations portal for agency administrators/staff alongside a passwordless wholesale portal for approved business customers.

---

## Key Features

### Admin & Staff Operations Portal (`/admin/*`, Sign-In at `/24102026`)
- **Manufacturer Management**: Supplier profiles, company galleries, private manufacturer asset uploads (GST certificates, rate cards, invoices), and category mappings.
- **Category & Catalog Management**: Hierarchical multi-level product categories, SKU catalog, draft vs. published controls, and multi-photo ordering.
- **Gross Margin Pricing Engine**: Hierarchy-based gross margin rules (`Product > Nearest Category Ancestor > Global`), live vs. draft price separation, bulk publish/sync controls, and price audit history.
- **Customer & Custom Pricing Management**: Self-registration approval queue (`pending -> active`), customer directory, delivery addresses, and isolated customer-specific SKU selling prices.
- **Order Fulfilment & Split Purchase Orders**: Automated customer order splitting into manufacturer-specific Purchase Orders, manual POs, stock receiving, and status workflow tracking.
- **Inventory & Ledger Tracking**: Real-time available/reserved/sold stock tracking, low-stock threshold alerts, and full movement audit trail.
- **Tax Invoices, Payments & Reports**: CGST/SGST/IGST invoice generation, partial/full settlement tracking, customer payment notice verification, financial analytics charts, Excel exports, and vector PDF master exports.

### Customer Wholesale Portal (`/customer/*`, Sign-In at `/login`, Registration at `/register`)
- **Passwordless Business Access & Onboarding**: Self-service business registration (`pending` admin approval) and instant passwordless entry by registered phone or email once approved.
- **Confidential Pricing Catalog**: Displays only published active products and customer-applicable selling prices (`v_customer_catalog` with `security_invoker = true`), keeping all manufacturer costs, margins, and POs strictly invisible.
- **Ordering, Tracking & Invoices**: Cart with MOQ and stock validation, multi-address delivery checkout, live order tracking, GST invoice PDF downloads, and payment notification submissions.
- **Mobile Responsive UI**: Responsive drawers, card layouts (`md:hidden`) alongside desktop tables (`hidden md:block`), and viewport-safe dialogs across mobile, tablet, and desktop breakpoints.

---

## Technology Stack

- **Frontend**: React 18, TypeScript 5, Vite 6, React Router v6
- **Styling & UI**: Tailwind CSS v3, Radix UI primitives, Lucide React icons
- **State & Data Fetching**: TanStack React Query v5, `@supabase/supabase-js` v2
- **Visualization & Exports**: Recharts, `jspdf`, `jspdf-autotable`, `xlsx`
- **Backend & Security**: Supabase PostgreSQL, Row Level Security (RLS), PostgreSQL RPC functions, Supabase Storage (`brand-assets`, `product-images`, `manufacturer-assets`), and Deno Edge Functions

---

## Prerequisites

- **Node.js** `20+` (or `22+` / `24 LTS`) and **npm**
- A **Supabase** project with Database, Auth, Storage, and Edge Functions enabled
- A **Vercel** account (for hosting) and **GitHub** repository (for CI/Git deployment)

---

## Local Installation

```bash
npm install
```

Copy the environment template and populate your Supabase credentials:

```bash
cp .env.example .env
```

On Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

---

## Environment Variables

Configure the following variables in `.env` (for local development) and in Vercel Project Settings (for Production & Preview deployments):

| Variable | Scope | Description |
| --- | --- | --- |
| `VITE_SUPABASE_URL` | Frontend (Public) | Your Supabase project URL (`https://<project-ref>.supabase.co`) |
| `VITE_SUPABASE_ANON_KEY` | Frontend (Public) | Your Supabase publishable (`sb_publishable_...`) or `anon` key |

> **Security Note:** Never place your Supabase `service_role` key, database password, or private API secrets in `.env` or any `VITE_` variable. All privileged operations run exclusively inside Supabase Edge Functions (`Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")`) or security-checked PostgreSQL RPCs.

---

## Supabase Configuration

1. **Database Schema, RPCs & RLS Migrations**:
   Apply all ordered SQL migrations in `supabase/migrations/` (`20261110000001_initial_schema.sql` through `20261111000005_audit_security_and_integrity_fixes.sql`) to your Supabase project.
   - Public business tables enable Row Level Security (`ALTER TABLE ... ENABLE ROW LEVEL SECURITY`).
   - Internal financial tables (`manufacturers`, `product_prices`, `margin_rules`, `purchase_orders`, `order_item_financials`, `admin_security_pins`, `audit_logs`) are restricted exclusively to active `admin` / `staff` users or server-side contexts.
   - `public.v_customer_catalog` runs with `security_invoker = true` and exposes only customer-safe selling prices.

2. **Storage Buckets**:
   - `brand-assets` (public read, admin/staff write)
   - `product-images` (public read, admin/staff write)
   - `manufacturer-assets` (private bucket — admin/staff access only via signed URLs)

3. **Edge Functions** (`supabase/functions/`):
   Deploy all 7 Edge Functions to your Supabase project:
   - `bootstrap-admin` (`verify_jwt: false`)
   - `username-login` (`verify_jwt: false`)
   - `customer-login` (`verify_jwt: false`)
   - `register-customer` (`verify_jwt: false`)
   - `admin-credentials` (`verify_jwt: true`)
   - `create-customer-user` (`verify_jwt: true`)
   - `manage-staff-user` (`verify_jwt: true`)

---

## Local Development

Start the Vite dev server:

```bash
npm run dev
```

Typecheck and create a production build:

```bash
npm run typecheck
npm run build
```

Preview the production bundle locally:

```bash
npm run preview
```

---

## Deployment on Vercel

The repository includes [`vercel.json`](./vercel.json) preconfigured for Vite SPA routing and security headers (`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`).

1. Import the GitHub repository into **Vercel**.
2. Confirm the Project Settings:
   - **Framework Preset**: `Vite`
   - **Install Command**: `npm install`
   - **Build Command**: `npm run build`
   - **Output Directory**: `dist`
3. Add **Environment Variables** in Vercel (`Production` and `Preview`):
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
4. Deploy. All routes (`/login`, `/register`, `/24102026`, `/admin/*`, `/customer/*`) rewrite cleanly to `index.html`.
