import { lazy, Suspense } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider } from "@/contexts/AuthContext";
import { ToastProvider } from "@/components/ui/toast";
import { ProtectedRoute } from "@/components/auth/ProtectedRoute";
import { AdminLayout } from "@/components/layouts/AdminLayout";
import { CustomerLayout } from "@/components/layouts/CustomerLayout";
import { LoginPage } from "@/pages/auth/LoginPage";

const AdminDashboardPage = lazy(() =>
  import("@/pages/admin/AdminDashboardPage").then((m) => ({ default: m.AdminDashboardPage }))
);
const CategoriesPage = lazy(() =>
  import("@/pages/admin/CategoriesPage").then((m) => ({ default: m.CategoriesPage }))
);
const ManufacturersPage = lazy(() =>
  import("@/pages/admin/ManufacturersPage").then((m) => ({ default: m.ManufacturersPage }))
);
const ManufacturerDetailPage = lazy(() =>
  import("@/pages/admin/ManufacturerDetailPage").then((m) => ({ default: m.ManufacturerDetailPage }))
);
const ProductCatalogPage = lazy(() =>
  import("@/pages/admin/ProductCatalogPage").then((m) => ({ default: m.ProductCatalogPage }))
);
const MarginPricingPage = lazy(() =>
  import("@/pages/admin/MarginPricingPage").then((m) => ({ default: m.MarginPricingPage }))
);
const CustomersPage = lazy(() =>
  import("@/pages/admin/CustomersPage").then((m) => ({ default: m.CustomersPage }))
);
const CustomerDetailPage = lazy(() =>
  import("@/pages/admin/CustomerDetailPage").then((m) => ({ default: m.CustomerDetailPage }))
);
const DailyOperationsPage = lazy(() =>
  import("@/pages/admin/DailyOperationsPage").then((m) => ({ default: m.DailyOperationsPage }))
);
const AdminOrdersPage = lazy(() =>
  import("@/pages/admin/AdminOrdersPage").then((m) => ({ default: m.AdminOrdersPage }))
);
const AdminOrderDetailPage = lazy(() =>
  import("@/pages/admin/AdminOrderDetailPage").then((m) => ({ default: m.AdminOrderDetailPage }))
);
const PurchaseOrdersPage = lazy(() =>
  import("@/pages/admin/PurchaseOrdersPage").then((m) => ({ default: m.PurchaseOrdersPage }))
);
const PurchaseOrderDetailPage = lazy(() =>
  import("@/pages/admin/PurchaseOrderDetailPage").then((m) => ({ default: m.PurchaseOrderDetailPage }))
);
const InventoryPage = lazy(() =>
  import("@/pages/admin/InventoryPage").then((m) => ({ default: m.InventoryPage }))
);
const InvoicesPage = lazy(() =>
  import("@/pages/admin/InvoicesPage").then((m) => ({ default: m.InvoicesPage }))
);
const ReportsPage = lazy(() =>
  import("@/pages/admin/ReportsPage").then((m) => ({ default: m.ReportsPage }))
);
const SettingsPage = lazy(() =>
  import("@/pages/admin/SettingsPage").then((m) => ({ default: m.SettingsPage }))
);

const CustomerHomePage = lazy(() =>
  import("@/pages/customer/CustomerHomePage").then((m) => ({ default: m.CustomerHomePage }))
);
const CustomerCategoriesPage = lazy(() =>
  import("@/pages/customer/CustomerCategoriesPage").then((m) => ({ default: m.CustomerCategoriesPage }))
);
const CustomerProductsPage = lazy(() =>
  import("@/pages/customer/CustomerProductsPage").then((m) => ({ default: m.CustomerProductsPage }))
);
const CustomerProductDetailPage = lazy(() =>
  import("@/pages/customer/CustomerProductDetailPage").then((m) => ({ default: m.CustomerProductDetailPage }))
);
const CustomerCartPage = lazy(() =>
  import("@/pages/customer/CustomerCartPage").then((m) => ({ default: m.CustomerCartPage }))
);
const CustomerOrdersPage = lazy(() =>
  import("@/pages/customer/CustomerOrdersPage").then((m) => ({ default: m.CustomerOrdersPage }))
);
const CustomerOrderDetailPage = lazy(() =>
  import("@/pages/customer/CustomerOrderDetailPage").then((m) => ({ default: m.CustomerOrderDetailPage }))
);
const CustomerInvoicesPage = lazy(() =>
  import("@/pages/customer/CustomerInvoicesPage").then((m) => ({ default: m.CustomerInvoicesPage }))
);
const CustomerProfilePage = lazy(() =>
  import("@/pages/customer/CustomerProfilePage").then((m) => ({ default: m.CustomerProfilePage }))
);

function RouteLoader() {
  return (
    <div className="flex min-h-[240px] items-center justify-center text-sm text-slate-500">
      Loading module...
    </div>
  );
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
    },
  },
});

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <AuthProvider>
          <BrowserRouter>
            <Suspense fallback={<RouteLoader />}>
              <Routes>
                <Route path="/login" element={<LoginPage />} />
                <Route path="/admin/login" element={<Navigate to="/login?portal=admin" replace />} />
                <Route path="/customer/login" element={<Navigate to="/login" replace />} />

                {/* ADMIN PORTAL (Admin & Staff Roles Only) */}
                <Route
                  path="/admin"
                  element={
                    <ProtectedRoute allowedRoles={["admin", "staff"]}>
                      <AdminLayout />
                    </ProtectedRoute>
                  }
                >
                  <Route index element={<Navigate to="/admin/dashboard" replace />} />
                  <Route path="dashboard" element={<AdminDashboardPage />} />
                  <Route path="manufacturers" element={<ManufacturersPage />} />
                  <Route path="manufacturers/categories" element={<ManufacturersPage />} />
                  <Route path="manufacturers/:id" element={<ManufacturerDetailPage />} />
                  <Route path="products" element={<ProductCatalogPage />} />
                  <Route path="categories" element={<CategoriesPage />} />
                  <Route path="pricing" element={<MarginPricingPage />} />
                  <Route path="customers" element={<CustomersPage />} />
                  <Route path="customers/:id" element={<CustomerDetailPage />} />
                  <Route path="operations" element={<DailyOperationsPage />} />
                  <Route path="orders" element={<AdminOrdersPage />} />
                  <Route path="orders/:id" element={<AdminOrderDetailPage />} />
                  <Route path="purchase-orders" element={<PurchaseOrdersPage />} />
                  <Route path="purchase-orders/:id" element={<PurchaseOrderDetailPage />} />
                  <Route path="inventory" element={<InventoryPage />} />
                  <Route path="invoices" element={<InvoicesPage />} />
                  <Route path="reports" element={<ReportsPage />} />
                  <Route path="settings" element={<SettingsPage />} />
                </Route>

                {/* CUSTOMER PORTAL (Customer Role Only) */}
                <Route
                  path="/customer"
                  element={
                    <ProtectedRoute allowedRoles={["customer"]}>
                      <CustomerLayout />
                    </ProtectedRoute>
                  }
                >
                  <Route index element={<Navigate to="/customer/home" replace />} />
                  <Route path="home" element={<CustomerHomePage />} />
                  <Route path="categories" element={<CustomerCategoriesPage />} />
                  <Route path="categories/:id" element={<CustomerCategoriesPage />} />
                  <Route path="products" element={<CustomerProductsPage />} />
                  <Route path="products/:id" element={<CustomerProductDetailPage />} />
                  <Route path="cart" element={<CustomerCartPage />} />
                  <Route path="orders" element={<CustomerOrdersPage />} />
                  <Route path="orders/:id" element={<CustomerOrderDetailPage />} />
                  <Route path="tracking" element={<CustomerOrdersPage />} />
                  <Route path="invoices" element={<CustomerInvoicesPage />} />
                  <Route path="profile" element={<CustomerProfilePage />} />
                </Route>

                <Route path="*" element={<Navigate to="/login" replace />} />
              </Routes>
            </Suspense>
          </BrowserRouter>
        </AuthProvider>
      </ToastProvider>
    </QueryClientProvider>
  );
}

export default App;
