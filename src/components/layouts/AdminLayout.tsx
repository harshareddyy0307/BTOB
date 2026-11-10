import { useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  LayoutDashboard,
  Factory,
  Package,
  FolderTree,
  Percent,
  Building2,
  ClipboardList,
  ShoppingBag,
  FileSpreadsheet,
  Boxes,
  ReceiptIndianRupee,
  BarChart3,
  Settings,
  PanelLeftClose,
  PanelLeftOpen,
  Bell,
  LogOut,
  Menu,
  X,
} from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

const ADMIN_NAV = [
  { label: "Dashboard", to: "/admin/dashboard", icon: LayoutDashboard },
  { label: "Manufacturer Management", to: "/admin/manufacturers", icon: Factory },
  { label: "Product Catalog", to: "/admin/products", icon: Package },
  { label: "Category Management", to: "/admin/categories", icon: FolderTree },
  { label: "Margin & Pricing", to: "/admin/pricing", icon: Percent },
  { label: "Customer Management", to: "/admin/customers", icon: Building2 },
  { label: "Daily Operations", to: "/admin/operations", icon: ClipboardList },
  { label: "Order Management", to: "/admin/orders", icon: ShoppingBag },
  { label: "Purchase Orders", to: "/admin/purchase-orders", icon: FileSpreadsheet },
  { label: "Inventory Management", to: "/admin/inventory", icon: Boxes },
  { label: "Invoices & Payments", to: "/admin/invoices", icon: ReceiptIndianRupee },
  { label: "Reports & Analytics", to: "/admin/reports", icon: BarChart3 },
  { label: "Settings", to: "/admin/settings", icon: Settings },
];

export function AdminLayout() {
  const { userProfile, branding, signOut } = useAuth();
  const navigate = useNavigate();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);

  const { data: notifications = [], refetch: refetchNotifs } = useQuery({
    queryKey: ["admin-notifications"],
    queryFn: async () => {
      const { data } = await supabase
        .from("notifications")
        .select("*")
        .in("recipient_role", ["admin", "staff"])
        .order("created_at", { ascending: false })
        .limit(15);
      return data ?? [];
    },
    refetchInterval: 15000,
  });

  const unreadCount = notifications.filter((n) => !n.is_read).length;

  const markAllRead = async () => {
    const unreadIds = notifications.filter((n) => !n.is_read).map((n) => n.id);
    if (unreadIds.length === 0) return;
    await supabase.from("notifications").update({ is_read: true }).in("id", unreadIds);
    refetchNotifs();
  };

  const handleNotificationClick = async (n: (typeof notifications)[number]) => {
    if (!n.is_read) {
      await supabase.from("notifications").update({ is_read: true }).eq("id", n.id);
      refetchNotifs();
    }
    setNotifOpen(false);
    if ((n.entity_type === "order" || n.entity_type === "order_payment_claim") && n.entity_id) {
      navigate(`/admin/orders/${n.entity_id}`);
    } else if (n.entity_type === "purchase_order" && n.entity_id) {
      navigate(`/admin/purchase-orders/${n.entity_id}`);
    }
  };

  const handleSignOut = async () => {
    await signOut();
    navigate("/login");
  };

  return (
    <div className="flex min-h-screen bg-slate-50 text-slate-900">
      {mobileOpen && (
        <div className="fixed inset-0 z-40 bg-slate-900/40 lg:hidden" onClick={() => setMobileOpen(false)} />
      )}

      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex flex-col border-r border-slate-200 bg-white transition-all duration-200 lg:static",
          collapsed ? "w-[72px]" : "w-64",
          mobileOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"
        )}
      >
        <div className="flex h-16 items-center justify-between border-b border-slate-200 px-4">
          {!collapsed && (
            <div className="flex min-w-0 items-center gap-2.5">
              {branding.logo_url && (
                <img
                  src={branding.logo_url}
                  alt={branding.agency_name}
                  className="h-8 w-8 shrink-0 rounded border border-slate-200 bg-white object-contain p-0.5"
                />
              )}
              <div className="min-w-0">
                <p className="truncate text-sm font-bold tracking-tight text-slate-900">{branding.agency_name}</p>
                <p className="text-[11px] font-medium uppercase tracking-wider text-blue-700">Admin Operations</p>
              </div>
            </div>
          )}
          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            className="hidden rounded-md p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-900 lg:inline-flex"
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {collapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
          </button>
          <button
            type="button"
            onClick={() => setMobileOpen(false)}
            className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 lg:hidden"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <nav className="flex-1 space-y-0.5 overflow-y-auto px-2.5 py-3">
          {ADMIN_NAV.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                onClick={() => setMobileOpen(false)}
                className={({ isActive }) =>
                  cn(
                    "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                    isActive
                      ? "bg-blue-50 text-blue-700"
                      : "text-slate-600 hover:bg-slate-100 hover:text-slate-900",
                    collapsed && "justify-center px-2"
                  )
                }
                title={collapsed ? item.label : undefined}
              >
                <Icon className="h-4 w-4 shrink-0" />
                {!collapsed && <span className="truncate">{item.label}</span>}
              </NavLink>
            );
          })}
        </nav>

        <div className="border-t border-slate-200 p-3">
          {!collapsed && (
            <div className="mb-2 rounded-md bg-slate-50 px-3 py-2">
              <p className="truncate text-xs font-semibold text-slate-800">{userProfile?.full_name}</p>
              <p className="truncate text-[11px] uppercase tracking-wide text-slate-500">{userProfile?.role}</p>
            </div>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={handleSignOut}
            className={cn("w-full justify-start text-slate-600 hover:text-red-700", collapsed && "justify-center px-0")}
          >
            <LogOut className="h-4 w-4 shrink-0" />
            {!collapsed && <span>Sign Out</span>}
          </Button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-16 items-center justify-between border-b border-slate-200 bg-white px-4 lg:px-6">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setMobileOpen(true)}
              className="rounded-md p-2 text-slate-600 hover:bg-slate-100 lg:hidden"
            >
              <Menu className="h-5 w-5" />
            </button>
            <span className="text-xs font-medium text-slate-500">
              Agency Management Portal &bull; Centralized Source of Truth
            </span>
          </div>

          <div className="relative flex items-center gap-3">
            <button
              type="button"
              onClick={() => setNotifOpen((o) => !o)}
              className="relative rounded-md border border-slate-200 bg-white p-2 text-slate-600 hover:bg-slate-50"
              title="Notifications"
              aria-label="Notifications"
            >
              <Bell className="h-4 w-4" />
              {unreadCount > 0 && (
                <span className="absolute -right-1 -top-1 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-blue-600 px-1 text-[10px] font-bold text-white">
                  {unreadCount}
                </span>
              )}
            </button>

            {notifOpen && (
              <div className="absolute right-0 top-12 z-50 w-80 rounded-lg border border-slate-200 bg-white p-3 shadow-lg">
                <div className="mb-2 flex items-center justify-between border-b border-slate-100 pb-2">
                  <span className="text-xs font-semibold uppercase tracking-wider text-slate-600">Notifications</span>
                  {unreadCount > 0 && (
                    <button onClick={markAllRead} className="text-xs font-medium text-blue-700 hover:underline">
                      Mark all read
                    </button>
                  )}
                </div>
                {notifications.length === 0 ? (
                  <p className="py-6 text-center text-xs text-slate-500">No notifications yet.</p>
                ) : (
                  <div className="max-h-72 space-y-2 overflow-y-auto">
                    {notifications.map((n) => (
                      <button
                        key={n.id}
                        type="button"
                        onClick={() => handleNotificationClick(n)}
                        className={cn(
                          "w-full rounded-md border p-2.5 text-left text-xs transition-colors hover:border-blue-300",
                          n.is_read ? "border-slate-100 bg-white" : "border-blue-200 bg-blue-50/70"
                        )}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <p className="font-semibold text-slate-900">{n.title}</p>
                          {n.entity_type === "order_payment_claim" && (
                            <span className="shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-800">
                              Payment
                            </span>
                          )}
                        </div>
                        <p className="mt-0.5 text-slate-600">{n.message}</p>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </header>

        <main className="flex-1 p-4 lg:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
