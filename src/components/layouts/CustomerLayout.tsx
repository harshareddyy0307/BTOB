import React, { useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Home,
  LayoutGrid,
  Package,
  ShoppingCart,
  ClipboardList,
  Truck,
  FileText,
  Building2,
  LogOut,
  Search,
  Menu,
  X,
} from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

const CUSTOMER_NAV = [
  { label: "Home", to: "/customer/home", icon: Home },
  { label: "Browse Categories", to: "/customer/categories", icon: LayoutGrid },
  { label: "All Products", to: "/customer/products", icon: Package },
  { label: "Cart", to: "/customer/cart", icon: ShoppingCart },
  { label: "My Orders", to: "/customer/orders", icon: ClipboardList },
  { label: "Order Tracking", to: "/customer/tracking", icon: Truck },
  { label: "Invoices", to: "/customer/invoices", icon: FileText },
  { label: "My Business Profile", to: "/customer/profile", icon: Building2 },
];

export function CustomerLayout() {
  const { customerProfile, branding, signOut } = useAuth();
  const navigate = useNavigate();
  const [searchTerm, setSearchTerm] = useState("");
  const [mobileMenu, setMobileMenu] = useState(false);

  const { data: cartCount = 0 } = useQuery({
    queryKey: ["customer-cart-count", customerProfile?.id],
    enabled: Boolean(customerProfile?.id),
    queryFn: async () => {
      const { count } = await supabase
        .from("cart_items")
        .select("*", { count: "exact", head: true })
        .eq("customer_id", customerProfile!.id)
        .eq("cart_status", "active");
      return count ?? 0;
    },
  });

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const q = searchTerm.trim();
    navigate(q ? `/customer/products?q=${encodeURIComponent(q)}` : "/customer/products");
  };

  const handleSignOut = async () => {
    await signOut();
    navigate("/login");
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="sticky top-0 z-40 border-b border-slate-200 bg-white">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-4 px-4 sm:px-6">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setMobileMenu((v) => !v)}
              className="rounded-md p-2 text-slate-600 hover:bg-slate-100 lg:hidden"
            >
              {mobileMenu ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </button>
            <NavLink to="/customer/home" className="flex items-center gap-2.5">
              {branding.logo_url && (
                <img
                  src={branding.logo_url}
                  alt={branding.agency_name}
                  className="h-8 w-8 shrink-0 rounded border border-slate-200 bg-white object-contain p-0.5"
                />
              )}
              <span className="flex flex-col">
                <span className="text-base font-bold tracking-tight text-slate-900">{branding.agency_name}</span>
                <span className="text-[11px] font-medium text-slate-500">B2B Wholesale Ordering Portal</span>
              </span>
            </NavLink>
          </div>

          <form onSubmit={handleSearchSubmit} className="hidden max-w-md flex-1 md:flex">
            <div className="relative w-full">
              <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
              <Input
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder="Search products by name or SKU..."
                className="pl-9"
              />
            </div>
          </form>

          <div className="flex items-center gap-3">
            <NavLink
              to="/customer/cart"
              className="relative inline-flex items-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              <ShoppingCart className="h-4 w-4 text-primary" />
              <span className="hidden sm:inline">Cart</span>
              <span className="inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-primary px-1.5 text-xs font-semibold text-white">
                {cartCount}
              </span>
            </NavLink>

            <div className="hidden text-right sm:block">
              <p className="text-xs font-semibold text-slate-800">{customerProfile?.business_name}</p>
              <p className="text-[11px] text-slate-500">{customerProfile?.owner_name}</p>
            </div>

            <Button variant="ghost" size="sm" onClick={handleSignOut} title="Sign Out">
              <LogOut className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </header>

      <div className="mx-auto flex max-w-7xl gap-6 px-4 py-6 sm:px-6">
        <aside
          className={cn(
            "w-60 shrink-0 lg:block",
            mobileMenu
              ? "fixed inset-y-16 left-0 z-30 border-r border-slate-200 bg-white p-4 shadow-lg"
              : "hidden"
          )}
        >
          <nav className="sticky top-22 space-y-1 rounded-lg border border-slate-200 bg-white p-2.5 shadow-sm">
            {CUSTOMER_NAV.map((item) => {
              const Icon = item.icon;
              return (
                <NavLink
                  key={item.to}
                  to={item.to}
                  onClick={() => setMobileMenu(false)}
                  className={({ isActive }) =>
                    cn(
                      "flex items-center justify-between rounded-md px-3 py-2 text-sm font-medium transition-colors",
                      isActive ? "bg-blue-50 text-blue-700" : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                    )
                  }
                >
                  <span className="flex items-center gap-2.5">
                    <Icon className="h-4 w-4 shrink-0" />
                    <span>{item.label}</span>
                  </span>
                  {item.to === "/customer/cart" && cartCount > 0 && (
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-700">
                      {cartCount}
                    </span>
                  )}
                </NavLink>
              );
            })}
          </nav>
        </aside>

        <main className="min-w-0 flex-1">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
