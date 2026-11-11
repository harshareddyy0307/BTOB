import React from "react";
import { Navigate, useLocation } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import type { UserRole } from "@/types/database";

import { Button } from "@/components/ui/button";

interface ProtectedRouteProps {
  allowedRoles: UserRole[];
  children: React.ReactNode;
}

export function ProtectedRoute({ allowedRoles, children }: ProtectedRouteProps) {
  const { session, role, customerProfile, loading, suppressReturnTo, signOut } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50">
        <div className="flex items-center gap-2.5 text-sm font-medium text-slate-600">
          <Loader2 className="h-5 w-5 animate-spin text-primary" />
          <span>Verifying session...</span>
        </div>
      </div>
    );
  }

  if (!session || !role) {
    const loginPath = suppressReturnTo && location.pathname.startsWith("/admin") ? "/login?portal=admin" : "/login";
    return <Navigate to={loginPath} state={suppressReturnTo ? undefined : { from: location }} replace />;
  }

  if (!allowedRoles.includes(role)) {
    return <Navigate to={role === "customer" ? "/customer/home" : "/admin/dashboard"} replace />;
  }

  if (role === "customer" && customerProfile && customerProfile.status !== "active") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 p-6">
        <div className="max-w-md rounded-lg border border-red-200 bg-white p-6 text-center shadow-sm">
          <h2 className="text-lg font-semibold text-slate-900">Business Account Inactive</h2>
          <p className="mt-2 text-sm text-slate-600">
            Your business account status is currently <strong>{customerProfile.status}</strong>. Please contact your
            supply agency administrator for assistance.
          </p>
          <Button variant="outline" size="sm" className="mt-4" onClick={() => void signOut()}>
            Sign Out
          </Button>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
