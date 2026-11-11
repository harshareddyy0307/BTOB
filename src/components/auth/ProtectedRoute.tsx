import React from "react";
import { Navigate, useLocation } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import type { UserRole } from "@/types/database";

interface ProtectedRouteProps {
  allowedRoles: UserRole[];
  children: React.ReactNode;
}

export function ProtectedRoute({ allowedRoles, children }: ProtectedRouteProps) {
  const { session, role, loading, suppressReturnTo } = useAuth();
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
    const loginPath = location.pathname.startsWith("/admin") ? "/24102026" : "/login";
    return <Navigate to={loginPath} state={suppressReturnTo ? undefined : { from: location }} replace />;
  }

  if (!allowedRoles.includes(role)) {
    return <Navigate to={role === "customer" ? "/customer/home" : "/admin/dashboard"} replace />;
  }

  return <>{children}</>;
}
