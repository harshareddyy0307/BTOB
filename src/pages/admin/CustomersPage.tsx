import React, { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { Plus, Building2, Eye, Pencil, Power, Loader2, CheckCircle2, XCircle, Clock, FileDown } from "lucide-react";
import { exportAllCustomersPdf } from "@/lib/adminPdfExports";
import { fetchAllRows, invokeAuthenticatedFunction, supabase } from "@/lib/supabase";
import { formatDate } from "@/lib/utils";
import type { CustomerProfile } from "@/types/database";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { StatusBadge } from "@/components/shared/StatusBadge";
import { useToast } from "@/components/ui/toast";

export function CustomersPage() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState(() => {
    const initial = searchParams.get("status") || "all";
    return ["all", "pending", "active", "inactive", "suspended"].includes(initial) ? initial : "all";
  });
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<CustomerProfile | null>(null);
  const [saving, setSaving] = useState(false);
  const [exportingPdf, setExportingPdf] = useState(false);
  const [togglingIds, setTogglingIds] = useState<Record<string, boolean>>({});

  const [businessName, setBusinessName] = useState("");
  const [ownerName, setOwnerName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [address, setAddress] = useState("");
  const [city, setCity] = useState("");
  const [stateVal, setStateVal] = useState("Telangana");
  const [pincode, setPincode] = useState("");
  const [gstNumber, setGstNumber] = useState("");
  const [businessCategory, setBusinessCategory] = useState("");
  const [status, setStatus] = useState<"pending" | "active" | "inactive" | "suspended">("active");

  useEffect(() => {
    const param = searchParams.get("status");
    if (param && ["all", "pending", "active", "inactive", "suspended"].includes(param)) {
      setStatusFilter(param);
    }
  }, [searchParams]);

  const handleStatusFilterChange = (val: string) => {
    setStatusFilter(val);
    if (val === "all") {
      searchParams.delete("status");
      setSearchParams(searchParams, { replace: true });
    } else {
      setSearchParams({ status: val }, { replace: true });
    }
  };

  const { data: customers = [], isLoading } = useQuery({
    queryKey: ["admin-customers"],
    queryFn: async () => {
      return await fetchAllRows<CustomerProfile>((from, to) =>
        supabase
          .from("customers")
          .select("*")
          .order("created_at", { ascending: false })
          .order("id", { ascending: true })
          .range(from, to)
      );
    },
  });

  const openCreate = () => {
    setEditing(null);
    setBusinessName("");
    setOwnerName("");
    setPhone("");
    setEmail("");
    setAddress("");
    setCity("");
    setStateVal("Telangana");
    setPincode("");
    setGstNumber("");
    setBusinessCategory("");
    setStatus("active");
    setModalOpen(true);
  };

  const openEdit = (c: CustomerProfile) => {
    setEditing(c);
    setBusinessName(c.business_name);
    setOwnerName(c.owner_name);
    setPhone(c.phone);
    setEmail(c.email);
    setAddress(c.business_address);
    setCity(c.city || "");
    setStateVal(c.state || "Telangana");
    setPincode(c.pincode || "");
    setGstNumber(c.gst_number || "");
    setBusinessCategory(c.business_category || "");
    setStatus(c.status);
    setModalOpen(true);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      if (editing) {
        const updatePayload: Record<string, unknown> = {
          business_name: businessName.trim(),
          owner_name: ownerName.trim(),
          phone: phone.trim(),
          business_address: address.trim(),
          city: city.trim() || null,
          state: stateVal.trim() || "Telangana",
          pincode: pincode.trim() || null,
          gst_number: gstNumber.trim().toUpperCase() || null,
          business_category: businessCategory.trim() || null,
        };
        if (!editing.user_id) {
          updatePayload.status = status;
        }

        const { error } = await supabase
          .from("customers")
          .update(updatePayload)
          .eq("id", editing.id);
        if (error) throw error;

        if (editing.user_id && status !== editing.status) {
          await invokeAuthenticatedFunction(
            "manage-staff-user",
            {
              action: "toggle_user_status",
              user_id: editing.user_id,
              is_active: status === "active",
              customer_status: status,
            },
            "Failed to sync customer login status"
          );
        }

        toast({ title: "Customer business updated", type: "success" });
        queryClient.invalidateQueries({ queryKey: ["admin-customer-detail", editing.id] });
      } else {
        await invokeAuthenticatedFunction(
          "create-customer-user",
          {
            business_name: businessName.trim(),
            owner_name: ownerName.trim(),
            phone: phone.trim(),
            email: email.trim().toLowerCase(),
            business_address: address.trim(),
            city: city.trim(),
            state: stateVal.trim(),
            pincode: pincode.trim(),
            gst_number: gstNumber.trim().toUpperCase(),
            business_category: businessCategory.trim(),
            status,
          },
          "Failed to provision customer account"
        );
        toast({
          title: "Customer business registered",
          description: `${businessName.trim()} can enter Customer Portal via ${phone.trim()} or ${email.trim().toLowerCase()} (no password needed).`,
          type: "success",
        });
      }

      setModalOpen(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["admin-customers"] }),
        queryClient.invalidateQueries({ queryKey: ["admin-pending-customers-count"] }),
        queryClient.invalidateQueries({ queryKey: ["admin-notifications"] }),
        queryClient.invalidateQueries({ queryKey: ["admin-dashboard-stats"] }),
      ]);
    } catch (err) {
      toast({
        title: "Failed to save customer",
        description: err instanceof Error ? err.message : "Error",
        type: "error",
      });
    } finally {
      setSaving(false);
    }
  };

  const updateCustomerAccess = async (c: CustomerProfile, grantAccess: boolean) => {
    if (togglingIds[c.id]) return;
    const nextStatus = grantAccess ? "active" : "inactive";
    setTogglingIds((prev) => ({ ...prev, [c.id]: true }));
    try {
      if (c.user_id) {
        await invokeAuthenticatedFunction(
          "manage-staff-user",
          {
            action: "toggle_user_status",
            user_id: c.user_id,
            is_active: grantAccess,
            customer_status: nextStatus,
          },
          "Failed to update customer access"
        );
      } else {
        const { error } = await supabase
          .from("customers")
          .update({ status: nextStatus })
          .eq("id", c.id);
        if (error) throw error;
      }

      const wasPending = c.status === "pending";
      toast({
        title: grantAccess
          ? wasPending
            ? `Access granted for ${c.business_name}`
            : `${c.business_name} activated`
          : wasPending
            ? `Registration declined for ${c.business_name}`
            : `${c.business_name} deactivated`,
        type: grantAccess ? "success" : "info",
      });

      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["admin-customers"] }),
        queryClient.invalidateQueries({ queryKey: ["admin-customer-detail", c.id] }),
        queryClient.invalidateQueries({ queryKey: ["admin-pending-customers-count"] }),
        queryClient.invalidateQueries({ queryKey: ["admin-notifications"] }),
        queryClient.invalidateQueries({ queryKey: ["admin-dashboard-stats"] }),
      ]);
    } catch (err) {
      toast({ title: "Status update failed", description: err instanceof Error ? err.message : "Error", type: "error" });
    } finally {
      setTogglingIds((prev) => {
        const next = { ...prev };
        delete next[c.id];
        return next;
      });
    }
  };

  const toggleStatus = async (c: CustomerProfile) => {
    const nextActive = c.status !== "active";
    await updateCustomerAccess(c, nextActive);
  };

  const pendingCustomers = customers.filter((c) => c.status === "pending");

  const filtered = customers.filter((c) => {
    if (statusFilter !== "all" && c.status !== statusFilter) return false;
    const q = search.toLowerCase();
    return (
      !q ||
      c.business_name.toLowerCase().includes(q) ||
      c.owner_name.toLowerCase().includes(q) ||
      c.email.toLowerCase().includes(q) ||
      (c.gst_number || "").toLowerCase().includes(q)
    );
  });

  const handleDownloadAllCustomersPdf = async () => {
    if (exportingPdf) return;
    setExportingPdf(true);
    try {
      const res = await exportAllCustomersPdf();
      toast({
        title: "Customers PDF downloaded",
        description: `Exported ${res.customerCount} customer(s), ${res.addressCount} saved address(es), and ${res.customPriceCount} custom price rule(s).`,
        type: "success",
      });
    } catch (err) {
      toast({
        title: "Could not export Customers PDF",
        description: err instanceof Error ? err.message : "Error",
        type: "error",
      });
    } finally {
      setExportingPdf(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-slate-900 sm:text-2xl">Customer Management</h1>
          <p className="text-sm text-slate-500">
            Manage registered local businesses, portal access approvals, outstanding dues, and custom pricing.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={handleDownloadAllCustomersPdf} disabled={exportingPdf}>
            {exportingPdf ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileDown className="h-4 w-4" />}
            Download All Customers PDF
          </Button>
          <Button onClick={openCreate}>
            <Plus className="h-4 w-4" />
            Add Customer Business
          </Button>
        </div>
      </div>

      {pendingCustomers.length > 0 && statusFilter !== "active" && statusFilter !== "inactive" && statusFilter !== "suspended" && (
        <Card className="border-amber-300 bg-amber-50/40">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base text-amber-950">
              <Clock className="h-4 w-4 text-amber-700" />
              Pending Registration Requests ({pendingCustomers.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {pendingCustomers.map((c) => (
              <div
                key={c.id}
                className="flex flex-col justify-between gap-3 rounded-lg border border-amber-200 bg-white p-3.5 sm:flex-row sm:items-center"
              >
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link to={`/admin/customers/${c.id}`} className="font-semibold text-slate-900 hover:underline">
                      {c.business_name}
                    </Link>
                    <StatusBadge status={c.status} />
                  </div>
                  <p className="text-xs text-slate-600">
                    Owner: <strong>{c.owner_name}</strong> &bull; {c.phone} &bull; {c.email}
                  </p>
                  <p className="text-xs text-slate-500">
                    {[c.business_address, c.city, c.state, c.pincode].filter(Boolean).join(", ")}
                    {c.gst_number ? ` • GSTIN: ${c.gst_number}` : ""}
                    {` • Requested ${formatDate(c.registered_at)}`}
                  </p>
                </div>

                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    onClick={() => void updateCustomerAccess(c, true)}
                    disabled={Boolean(togglingIds[c.id])}
                    className="bg-emerald-600 text-white hover:bg-emerald-700"
                  >
                    {togglingIds[c.id] ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <CheckCircle2 className="h-3.5 w-3.5" />
                    )}
                    Grant Access
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void updateCustomerAccess(c, false)}
                    disabled={Boolean(togglingIds[c.id])}
                  >
                    <XCircle className="h-3.5 w-3.5 text-red-600" />
                    Decline
                  </Button>
                  <Link
                    to={`/admin/customers/${c.id}`}
                    className="inline-flex h-8 items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                  >
                    <Eye className="h-3.5 w-3.5" />
                    Details
                  </Link>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle className="flex items-center gap-2">
            <Building2 className="h-4 w-4 text-blue-700" />
            Registered Businesses ({filtered.length})
          </CardTitle>
          <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search business, owner, GST..."
              className="w-full sm:w-64"
            />
            <Select value={statusFilter} onValueChange={handleStatusFilterChange}>
              <SelectTrigger className="w-full sm:w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Statuses</SelectItem>
                <SelectItem value="pending">Pending Approval</SelectItem>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="inactive">Inactive</SelectItem>
                <SelectItem value="suspended">Suspended</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <div className="divide-y divide-slate-100 md:hidden">
            {isLoading ? (
              <div className="py-8 text-center text-sm text-slate-500">Loading customers...</div>
            ) : filtered.length === 0 ? (
              <div className="py-8 text-center text-sm text-slate-500">No registered businesses found.</div>
            ) : (
              filtered.map((c) => (
                <div key={c.id} className="space-y-2.5 p-4 text-xs">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <Link to={`/admin/customers/${c.id}`} className="text-sm font-semibold text-slate-900 hover:underline">
                        {c.business_name}
                      </Link>
                      <p className="text-slate-500">{c.business_category || "Local Business"}</p>
                    </div>
                    <StatusBadge status={c.status} />
                  </div>
                  <div className="space-y-0.5 text-slate-600">
                    <p className="font-medium text-slate-800">{c.owner_name}</p>
                    <p className="break-all">
                      {c.phone} &bull; {c.email}
                    </p>
                    <p className="text-slate-500">
                      {[c.city, c.state].filter(Boolean).join(", ")}
                      {c.gst_number ? ` • GSTIN: ${c.gst_number}` : ""} &bull; Reg: {formatDate(c.registered_at)}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center justify-end gap-1.5 border-t border-slate-100 pt-2">
                    {c.status === "pending" && (
                      <Button
                        size="sm"
                        onClick={() => void updateCustomerAccess(c, true)}
                        disabled={Boolean(togglingIds[c.id])}
                        className="h-8 bg-emerald-600 px-2.5 text-xs text-white hover:bg-emerald-700"
                      >
                        {togglingIds[c.id] ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <CheckCircle2 className="h-3.5 w-3.5" />
                        )}
                        Grant Access
                      </Button>
                    )}
                    <Link
                      to={`/admin/customers/${c.id}`}
                      className="inline-flex h-8 items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                    >
                      <Eye className="h-3.5 w-3.5" />
                      Profile
                    </Link>
                    <Button variant="ghost" size="icon" onClick={() => openEdit(c)} title="Edit">
                      <Pencil className="h-4 w-4" />
                    </Button>
                    {c.status === "pending" ? (
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => void updateCustomerAccess(c, false)}
                        disabled={Boolean(togglingIds[c.id])}
                        aria-label={`Decline ${c.business_name}`}
                        title="Decline registration"
                      >
                        <XCircle className="h-4 w-4 text-red-600" />
                      </Button>
                    ) : (
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => toggleStatus(c)}
                        disabled={Boolean(togglingIds[c.id])}
                        aria-label={c.status === "active" ? `Deactivate ${c.business_name}` : `Activate ${c.business_name}`}
                        title={c.status === "active" ? "Deactivate customer" : "Activate customer"}
                      >
                        {togglingIds[c.id] ? (
                          <Loader2 className="h-4 w-4 animate-spin text-slate-500" />
                        ) : (
                          <Power className={c.status === "active" ? "h-4 w-4 text-amber-600" : "h-4 w-4 text-emerald-600"} />
                        )}
                      </Button>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="hidden md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Business</TableHead>
                  <TableHead>Owner &amp; Contact</TableHead>
                  <TableHead>Location</TableHead>
                  <TableHead>GSTIN</TableHead>
                  <TableHead>Registered</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow>
                    <TableCell colSpan={7} className="py-8 text-center text-slate-500">
                      Loading customers...
                    </TableCell>
                  </TableRow>
                ) : filtered.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="py-8 text-center text-slate-500">
                      No registered businesses found.
                    </TableCell>
                  </TableRow>
                ) : (
                  filtered.map((c) => (
                    <TableRow key={c.id}>
                      <TableCell>
                        <Link to={`/admin/customers/${c.id}`} className="font-semibold text-slate-900 hover:underline">
                          {c.business_name}
                        </Link>
                        <p className="text-xs text-slate-500">{c.business_category || "Local Business"}</p>
                      </TableCell>
                      <TableCell>
                        <p className="text-sm font-medium text-slate-800">{c.owner_name}</p>
                        <p className="text-xs text-slate-500">
                          {c.phone} &bull; {c.email}
                        </p>
                      </TableCell>
                      <TableCell className="text-xs text-slate-600">
                        {[c.city, c.state].filter(Boolean).join(", ")}
                      </TableCell>
                      <TableCell className="font-mono text-xs text-slate-600">{c.gst_number || "—"}</TableCell>
                      <TableCell className="text-xs text-slate-500">{formatDate(c.registered_at)}</TableCell>
                      <TableCell>
                        <StatusBadge status={c.status} />
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="inline-flex items-center gap-1">
                          {c.status === "pending" && (
                            <Button
                              size="sm"
                              onClick={() => void updateCustomerAccess(c, true)}
                              disabled={Boolean(togglingIds[c.id])}
                              className="h-8 bg-emerald-600 px-2.5 text-xs text-white hover:bg-emerald-700"
                            >
                              {togglingIds[c.id] ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <CheckCircle2 className="h-3.5 w-3.5" />
                              )}
                              Grant Access
                            </Button>
                          )}
                          <Link
                            to={`/admin/customers/${c.id}`}
                            className="inline-flex h-8 items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                          >
                            <Eye className="h-3.5 w-3.5" />
                            Profile
                          </Link>
                          <Button variant="ghost" size="icon" onClick={() => openEdit(c)} title="Edit">
                            <Pencil className="h-4 w-4" />
                          </Button>
                          {c.status === "pending" ? (
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => void updateCustomerAccess(c, false)}
                              disabled={Boolean(togglingIds[c.id])}
                              aria-label={`Decline ${c.business_name}`}
                              title="Decline registration"
                            >
                              <XCircle className="h-4 w-4 text-red-600" />
                            </Button>
                          ) : (
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => toggleStatus(c)}
                              disabled={Boolean(togglingIds[c.id])}
                              aria-label={c.status === "active" ? `Deactivate ${c.business_name}` : `Activate ${c.business_name}`}
                              title={c.status === "active" ? "Deactivate customer" : "Activate customer"}
                            >
                              {togglingIds[c.id] ? (
                                <Loader2 className="h-4 w-4 animate-spin text-slate-500" />
                              ) : (
                                <Power className={c.status === "active" ? "h-4 w-4 text-amber-600" : "h-4 w-4 text-emerald-600"} />
                              )}
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Dialog open={modalOpen} onOpenChange={setModalOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit Customer Business" : "Register New Customer Business"}</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSave} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Business Name *</Label>
                <Input value={businessName} onChange={(e) => setBusinessName(e.target.value)} required />
              </div>
              <div className="space-y-1.5">
                <Label>Owner / Primary Contact Name *</Label>
                <Input value={ownerName} onChange={(e) => setOwnerName(e.target.value)} required />
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Phone Number *</Label>
                <Input value={phone} onChange={(e) => setPhone(e.target.value)} required />
              </div>
              <div className="space-y-1.5">
                <Label>Business / Login Email *</Label>
                <Input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  disabled={Boolean(editing)}
                />
              </div>
            </div>

            {!editing && (
              <div className="rounded-md border border-blue-100 bg-blue-50 px-3 py-2 text-xs text-blue-800">
                No password needed &mdash; once registered, the business can enter the Customer Portal directly using
                their registered phone number or email.
              </div>
            )}

            <div className="space-y-1.5">
              <Label>Business Address *</Label>
              <Input value={address} onChange={(e) => setAddress(e.target.value)} required />
            </div>

            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label>City</Label>
                <Input value={city} onChange={(e) => setCity(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label>State *</Label>
                <Input value={stateVal} onChange={(e) => setStateVal(e.target.value)} required />
              </div>
              <div className="space-y-1.5">
                <Label>Pincode</Label>
                <Input value={pincode} onChange={(e) => setPincode(e.target.value)} />
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label>GST Number</Label>
                <Input value={gstNumber} onChange={(e) => setGstNumber(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label>Business Category</Label>
                <Input
                  value={businessCategory}
                  onChange={(e) => setBusinessCategory(e.target.value)}
                  placeholder="Retail / Hardware Store / Office"
                />
              </div>
              <div className="space-y-1.5">
                <Label>Account Status</Label>
                <Select
                  value={status}
                  onValueChange={(v) => setStatus(v as "pending" | "active" | "inactive" | "suspended")}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {editing?.status === "pending" && <SelectItem value="pending">Pending Approval</SelectItem>}
                    <SelectItem value="active">Active</SelectItem>
                    <SelectItem value="inactive">Inactive</SelectItem>
                    <SelectItem value="suspended">Suspended</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setModalOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={saving}>
                {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                {editing ? "Save Changes" : "Create Customer Account"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
